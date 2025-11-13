// ========================= backend/orders/orders.route.js =========================
const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer"); // ✅ لإرسال الإيميلات
require("dotenv").config();

const Order = require("./orders.model");
const Product = require("../products/products.model");
const { Types } = require("mongoose");

const router = express.Router();

// دالة مساعدة لحساب رسوم الشحن حسب المجموع الفرعي (بالريال العُماني)
function computeShippingFee(subtotalOMR) {
  if (subtotalOMR < 10) return 2;
  if (subtotalOMR <= 20) return 1;
  return 0;
}

// ======================= إنشاء جلسة دفع =======================
router.post("/create-checkout-session", async (req, res) => {
  const {
    products,
    // email,
    customerName,
    customerPhone,
    country,
    wilayat,
    description,
  } = req.body;

  const THAWANI_API_KEY = process.env.THAWANI_API_KEY;
  const THAWANI_API_URL = process.env.THAWANI_API_URL;
  const THAWANI_PUBLISH_KEY =
    process.env.THAWANI_PUBLISH_KEY ||
    process.env.THAWANI_PUBLISHABLE_KEY ||
    process.env.THAWANI_PUBLIC_KEY;

  if (!THAWANI_API_KEY || !THAWANI_API_URL || !THAWANI_PUBLISH_KEY) {
    return res
      .status(500)
      .json({ error: "Thawani keys not configured on the server" });
  }

  const CHECKOUT_HOST = "https://checkout.thawani.om";

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  try {
    const subtotal = products.reduce(
      (total, p) => total + Number(p.price) * Number(p.quantity),
      0
    );

    const shippingFee = computeShippingFee(subtotal);
    const totalAmount = subtotal + shippingFee;

    const lineItems = products.map((p) => ({
      name: p.name,
      productId: p._id,
      quantity: Number(p.quantity),
      unit_amount: Math.round(Number(p.price) * 1000), // بالبيسة
    }));

    if (shippingFee > 0) {
      lineItems.push({
        name: "رسوم الشحن",
        quantity: 1,
        unit_amount: Math.round(shippingFee * 1000),
      });
    }

    const nowId = Date.now().toString();

    const data = {
      client_reference_id: nowId,
      mode: "payment",
      products: lineItems,
      success_url:
        "https://www.baby7aven.com/SuccessRedirect?client_reference_id=" + nowId,
      cancel_url: "https://www.baby7aven.com/checkout",
      metadata: {
        customer_name: customerName,
        customer_phone: customerPhone,
        // email: email || "غير محدد",
        country,
        wilayat,
        description: description || "لا يوجد وصف",
        internal_order_id: nowId,
        source: "mern-backend",
      },
    };

    const response = await axios.post(`${THAWANI_API_URL}/checkout/session`, data, {
      headers: {
        "Content-Type": "application/json",
        "thawani-api-key": THAWANI_API_KEY,
      },
    });

    const sessionId = response.data?.data?.session_id;
    if (!sessionId) {
      return res.status(500).json({ error: "Thawani did not return session_id" });
    }

    const paymentLink = `${CHECKOUT_HOST}/pay/${sessionId}?key=${THAWANI_PUBLISH_KEY}`;

    const order = new Order({
      orderId: sessionId,
      products: products.map((p) => ({
        productId: p._id,
        quantity: Number(p.quantity),
        name: p.name,
        price: Number(p.price),
        image: Array.isArray(p.image) ? p.image[0] : p.image,

        chosenColor: p.chosenColor || p.color || "",
        chosenSize:  p.chosenSize  || p.size  || "",
        chosenCount: (p.chosenCount || p.count || (p.chosenOption && p.chosenOption.label)) || "",
      })),
      amount: totalAmount,
      shippingFee,
      customerName,
      customerPhone,
      country,
      wilayat,
      description,
      // email,
      status: "pending",
    });

    await order.save();

    return res.json({ id: sessionId, paymentLink });
  } catch (error) {
    console.error("Error creating checkout session:", error?.response?.data || error);
    return res.status(500).json({
      error: "Failed to create checkout session",
      details: error.message,
    });
  }
});

// ======================= استرجاع طلب بمنتجاته =======================
router.get("/order-with-products/:orderId", async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const products = await Promise.all(
      order.products.map(async (item) => {
        const product = await Product.findById(item.productId);
        if (!product) return null;
        return {
          ...product.toObject(),
          quantity: item.quantity,
          chosenColor: item.chosenColor || "",
          chosenSize:  item.chosenSize  || "",
          chosenCount: item.chosenCount || "",
          lineTotal: (Number(item.price) * Number(item.quantity)).toFixed(2),
        };
      })
    );

    res.json({ order, products: products.filter(Boolean) });
  } catch (err) {
    console.error("order-with-products error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================= تأكيد الدفع + خصم المخزون =======================
router.post("/confirm-payment", async (req, res) => {
  const { client_reference_id } = req.body;

  const THAWANI_API_KEY = process.env.THAWANI_API_KEY;
  const THAWANI_API_URL = process.env.THAWANI_API_URL;

  if (!client_reference_id) {
    return res.status(400).json({ error: "Session ID is required" });
  }
  if (!THAWANI_API_KEY || !THAWANI_API_URL) {
    return res.status(500).json({ error: "Thawani keys not configured on the server" });
  }

  try {
    // ابحث عن الجلسة
    const sessionsResponse = await axios.get(
      `${THAWANI_API_URL}/checkout/session/?limit=10&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const sessionsList = sessionsResponse.data?.data || [];
    const session_ = sessionsList.find(
      (s) => s.client_reference_id === client_reference_id
    );
    if (!session_) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session_id = session_.session_id;

    const response = await axios.get(
      `${THAWANI_API_URL}/checkout/session/${session_id}?limit=1&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const session = response.data?.data;
    if (!session || session.payment_status !== "paid") {
      return res
        .status(400)
        .json({ error: "Payment not successful or session not found" });
    }

    // حمّل الطلب من قواعدك
    let order = await Order.findOne({ orderId: session_id });
    let shouldDecrementStock = false;

    if (!order) {
      const shippingItem = (session.products || []).find((i) => i.name === "رسوم الشحن");
      const shippingFeeFromSession = shippingItem ? (Number(shippingItem.unit_amount || 0) / 1000) : 0;

      order = new Order({
        orderId: session_id,
        products: (session.products || [])
          .filter((i) => i.name !== "رسوم الشحن")
          .map((item) => ({
            productId: item.productId || "",
            quantity: Number(item.quantity),
            name: item.name,
            price: Number(item.unit_amount || 0) / 1000,
            image: "",
            chosenColor: "",
            chosenSize: "",
            chosenCount: "",
          })),
        amount: Number(session.total_amount || 0) / 1000,
        shippingFee: shippingFeeFromSession,
        status: "completed",
        customerName: "",
        customerPhone: "",
        country: "",
        wilayat: "",
        description: "",
        // email: "",
        currency: "OMR",
      });
      shouldDecrementStock = true;
    } else {
      const wasCompleted = order.status === "completed";
      order.status = "completed";
      shouldDecrementStock = !wasCompleted;
    }

    await order.save();

    // ✅ إنقاص المخزون وفق (لون/خيار/عام)
    if (shouldDecrementStock && Array.isArray(order.products) && order.products.length > 0) {
      // جهّز IDs
      const ids = order.products
        .map((it) => (Types.ObjectId.isValid(it.productId) ? new Types.ObjectId(it.productId) : null))
        .filter(Boolean);

      // اجلب المنتجات ذات الصلة لمرة واحدة
      const docs = await Product.find({ _id: { $in: ids } })
        .select("_id stock colorsStock countPrices")
        .lean();

      const map = new Map(docs.map((d) => [String(d._id), d]));

      const ops = [];

      for (const item of order.products) {
        const qty = Number(item.quantity) || 0;
        if (qty <= 0) continue;
        if (!Types.ObjectId.isValid(item.productId)) continue;

        const _id = new Types.ObjectId(item.productId);
        const doc = map.get(String(_id));
        if (!doc) continue;

        const chosenColor = (item.chosenColor || "").trim();
        const chosenCount = (item.chosenCount || "").trim();

        // هل يوجد مخزون مُعرّف للّون؟
        const hasColorStock =
          chosenColor &&
          Array.isArray(doc.colorsStock) &&
          doc.colorsStock.some(
            (c) =>
              String(c?.color || "").toLowerCase() === chosenColor.toLowerCase() &&
              typeof c?.stock === "number"
          );

        // هل يوجد مخزون مُعرّف للخيار (عدد القطع)؟
        const hasOptionStock =
          chosenCount &&
          Array.isArray(doc.countPrices) &&
          doc.countPrices.some(
            (o) =>
              String(o?.count || "").trim() === chosenCount &&
              typeof o?.stock === "number"
          );

        // إعداد الفلاتر والتحديثات
        const filter = { _id, stock: { $gte: qty } };
        const update = { $inc: { stock: -qty } };
        const arrayFilters = [];

        if (hasColorStock) {
          filter.colorsStock = { $elemMatch: { color: chosenColor, stock: { $gte: qty } } };
          update.$inc["colorsStock.$[c].stock"] = -qty;
          arrayFilters.push({ "c.color": chosenColor, "c.stock": { $gte: qty } });
        }

        if (hasOptionStock) {
          filter.countPrices = { $elemMatch: { count: chosenCount, stock: { $gte: qty } } };
          update.$inc["countPrices.$[o].stock"] = -qty;
          arrayFilters.push({ "o.count": chosenCount, "o.stock": { $gte: qty } });
        }

        // ملاحظة:
        // - إذا لا يوجد مخزون تفصيلي لأي من اللون/الخيار، سنخصم من المخزون العام فقط بشرط stock>=qty.
        // - إذا يوجد مخزون تفصيلي، الفلتر يشترط توافر الكمية في المخزون التفصيلي أيضًا، والخصم يتم على التفصيلي + العام معًا.

        ops.push({
          updateOne: {
            filter,
            update,
            ...(arrayFilters.length ? { arrayFilters } : {}),
          },
        });
      }

      if (ops.length > 0) {
        try {
          await Product.bulkWrite(ops, { ordered: false });
        } catch (e) {
          console.error("bulkWrite stock decrement error:", e);
        }
      }
    }

    return res.json({ order });
  } catch (error) {
    console.error("Error confirming payment:", error?.response?.data || error);
    return res
      .status(500)
      .json({ error: "Failed to confirm payment", details: error.message });
  }
});

// ======================= إرسال إيميل لصاحب المتجر =======================
// ======================= إرسال إيميل لصاحب المتجر =======================
router.post("/notify-admin", async (req, res) => {
  try {
    const {
      to,
      orderId,
      status,
      amount,
      customerName,
      customerPhone,
      country,
      wilayat,
      products = [],
    } = req.body;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // صفوف المنتجات داخل الجدول
    const productsRows = (products || [])
      .map(
        (p, i) => `
          <tr>
            <td style="border:1px solid #ddd;padding:8px;text-align:center;">${i + 1}</td>
            <td style="border:1px solid #ddd;padding:8px;">${p.name || p.productId || "-"}</td>
            <td style="border:1px solid #ddd;padding:8px;text-align:center;">${p.quantity || 1}</td>
            <td style="border:1px solid #ddd;padding:8px;text-align:center;">${p.chosenSize || "-"}</td>
            <td style="border:1px solid #ddd;padding:8px;text-align:center;">${p.chosenColor || "-"}</td>
            <td style="border:1px solid #ddd;padding:8px;text-align:center;">${p.chosenCount || "-"}</td>
            <td style="border:1px solid #ddd;padding:8px;text-align:center;">${p.price || "-"}</td>
          </tr>
        `
      )
      .join("");

    const mailOptions = {
      from: `" متجر baby7aven
" <${process.env.SMTP_USER}>`,
      to: to || "baby7aven.om@gmail.com",
      subject: `فاتورة طلب جديد #${orderId || ""}`,
      html: `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <title>فاتورة الطلب</title>
  </head>
  <body style="font-family: Tahoma, Arial, sans-serif; background-color:#f5f5f5; padding:20px;">
    <div style="max-width:700px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
      
      <!-- الهيدر -->
      <div style="background:#4f46e5;color:#ffffff;padding:16px 24px;text-align:center;">
        <h2 style="margin:0;font-size:22px;">متجر baby7aven</h2>
        <p style="margin:4px 0 0;font-size:14px;">فاتورة طلب جديد</p>
      </div>

      <!-- معلومات عامة عن الطلب -->
      <div style="padding:20px;">
        <h3 style="margin-top:0;margin-bottom:12px;font-size:18px;">تفاصيل الطلب</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <tbody>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">رقم الطلب:</td>
              <td style="padding:6px 0;">${orderId || "-"}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">حالة الطلب:</td>
              <td style="padding:6px 0;">${status || "-"}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">المبلغ الكلي:</td>
              <td style="padding:6px 0;">${amount || "-"} ر.ع</td>
            </tr>
          </tbody>
        </table>

        <h3 style="margin-top:16px;margin-bottom:12px;font-size:18px;">بيانات العميل</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <tbody>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">اسم العميل:</td>
              <td style="padding:6px 0;">${customerName || "-"}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">رقم الهاتف:</td>
              <td style="padding:6px 0;">${customerPhone || "-"}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">البلد:</td>
              <td style="padding:6px 0;">${country || "-"}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;">الولاية:</td>
              <td style="padding:6px 0;">${wilayat || "-"}</td>
            </tr>
          </tbody>
        </table>

        <h3 style="margin-top:16px;margin-bottom:12px;font-size:18px;">تفاصيل المنتجات</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="border:1px solid #ddd;padding:8px;">#</th>
              <th style="border:1px solid #ddd;padding:8px;">المنتج</th>
              <th style="border:1px solid #ddd;padding:8px;">الكمية</th>
              <th style="border:1px solid #ddd;padding:8px;">المقاس</th>
              <th style="border:1px solid #ddd;padding:8px;">اللون</th>
              <th style="border:1px solid #ddd;padding:8px;">عدد القطع</th>
              <th style="border:1px solid #ddd;padding:8px;">السعر</th>
            </tr>
          </thead>
          <tbody>
            ${productsRows || `
              <tr>
                <td colspan="7" style="border:1px solid #ddd;padding:8px;text-align:center;">
                  لا توجد منتجات في هذا الطلب
                </td>
              </tr>
            `}
          </tbody>
        </table>

        <p style="margin-top:24px;font-size:13px;color:#555;text-align:center;">
          شكرًا لتعاملك مع <strong> مبادر</strong> 🌿
        </p>
      </div>
    </div>
  </body>
</html>
      `,
    };

    await transporter.sendMail(mailOptions);

    return res.json({ message: "Admin email sent successfully" });
  } catch (error) {
    console.error("Error sending admin email:", error);
    return res
      .status(500)
      .json({ error: "Failed to send admin email", details: error.message });
  }
});

// ======================= طلبات حسب البريد =======================
router.get("/:email", async (req, res) => {
  const email = req.params.email;
  if (!email) return res.status(400).send({ message: "Email is required" });

  try {
    const orders = await Order.find({ email });
    if (orders.length === 0) {
      return res.status(404).send({ message: "No orders found for this email" });
    }
    res.status(200).send({ orders });
  } catch (error) {
    console.error("Error fetching orders by email:", error);
    res.status(500).send({ message: "Failed to fetch orders by email" });
  }
});

// ======================= طلب واحد =======================
router.get("/order/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }
    res.status(200).send(order);
  } catch (error) {
    console.error("Error fetching orders by user id", error);
    res.status(500).send({ message: "Failed to fetch orders by user id" });
  }
});

// ======================= جميع الطلبات المنتهية =======================
router.get("/", async (req, res) => {
  try {
    const orders = await Order.find({ status: "completed" }).sort({ createdAt: -1 });
    if (orders.length === 0) {
      return res.status(404).send({ message: "No orders found", orders: [] });
    }
    res.status(200).send(orders);
  } catch (error) {
    console.error("Error fetching all orders", error);
    res.status(500).send({ message: "Failed to fetch all orders" });
  }
});

// ======================= تحديث حالة الطلب =======================
router.patch("/update-order-status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).send({ message: "Status is required" });
  }

  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      { status, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!updatedOrder) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.status(200).json({
      message: "Order status updated successfully",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order status", error);
    res.status(500).send({ message: "Failed to update order status" });
  }
});

// ======================= حذف طلب =======================
router.delete("/delete-order/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const deletedOrder = await Order.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res.status(404).send({ message: "Order not found" });
    }
    res.status(200).json({
      message: "Order deleted successfully",
      order: deletedOrder,
    });
  } catch (error) {
    console.error("Error deleting order", error);
    res.status(500).send({ message: "Failed to delete order" });
  }
});

module.exports = router;
