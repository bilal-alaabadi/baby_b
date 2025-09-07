// routes/orders.js
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const Order = require("./orders.model");
const Product = require("../products/products.model"); // تأكد من المسار الصحيح
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
    email,
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

  const CHECKOUT_HOST = THAWANI_API_URL.includes("uat")
    ? "https://uatcheckout.thawani.om"
    : "https://checkout.thawani.om";

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  try {
    // المجموع الفرعي بالريال
    const subtotal = products.reduce(
      (total, p) => total + Number(p.price) * Number(p.quantity),
      0
    );

    // ✅ حساب الشحن وفق القاعدة الجديدة
    const shippingFee = computeShippingFee(subtotal);
    const totalAmount = subtotal + shippingFee;

    const lineItems = products.map((p) => ({
      name: p.name,
      productId: p._id, // لأغراضك فقط
      quantity: Number(p.quantity),
      unit_amount: Math.round(Number(p.price) * 1000), // بالبيسة
    }));

    // أضف رسوم الشحن كبند مستقل فقط إذا > 0
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
        "http://localhost:5173/SuccessRedirect?client_reference_id=" + nowId,
      cancel_url: "http://localhost:5173/cancel",
      metadata: {
        customer_name: customerName,
        customer_phone: customerPhone,
        email: email || "غير محدد",
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

    // خزّن الطلب بحالة pending
    const order = new Order({
      orderId: sessionId,
      products: products.map((p) => ({
        productId: p._id,
        quantity: Number(p.quantity),
        name: p.name,
        price: Number(p.price),
        image: Array.isArray(p.image) ? p.image[0] : p.image,
      })),
      amount: totalAmount,
      shippingFee, // ✅ يحفظ الرسوم المحسوبة
      customerName,
      customerPhone,
      country,
      wilayat,
      description,
      email,
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
          selectedSize: item.selectedSize,
          price:
            product.category === "حناء بودر" &&
            item.selectedSize &&
            product.price[item.selectedSize]
              ? (product.price[item.selectedSize] * item.quantity).toFixed(2)
              : ((product.regularPrice || product.price) * item.quantity).toFixed(2),
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
    // 1) إيجاد الجلسة
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

    // 2) تفاصيل الجلسة للتأكد من الدفع
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

    // 3) تحديث/إنشاء الطلب
    let order = await Order.findOne({ orderId: session_id });
    let shouldDecrementStock = false;

    if (!order) {
      // حالة نادرة: ننشئ طلبًا من الجلسة
      const shippingItem = (session.products || []).find((i) => i.name === "رسوم الشحن");
      const shippingFeeFromSession = shippingItem ? (Number(shippingItem.unit_amount || 0) / 1000) : 0;

      order = new Order({
        orderId: session_id,
        products: (session.products || [])
          .filter((i) => i.name !== "رسوم الشحن")
          .map((item) => ({
            productId: item.productId, // قد لا يتوفر من ثواني
            quantity: Number(item.quantity),
            name: item.name,
            price: Number(item.unit_amount || 0) / 1000,
            image: "",
          })),
        amount: Number(session.total_amount || 0) / 1000,
        shippingFee: shippingFeeFromSession,
        status: "completed",
        customerName: "",
        customerPhone: "",
        country: "",
        wilayat: "",
        description: "",
        email: "",
        currency: "OMR",
      });
      shouldDecrementStock = true;
    } else {
      const wasCompleted = order.status === "completed";
      order.status = "completed";
      shouldDecrementStock = !wasCompleted;
    }

    await order.save();

    // 4) خصم المخزون — مع تحويل id إلى ObjectId
    if (shouldDecrementStock && Array.isArray(order.products) && order.products.length > 0) {
      const ops = order.products
        .map((item) => {
          const qty = Number(item.quantity) || 0;
          if (qty <= 0) return null;
          if (!Types.ObjectId.isValid(item.productId)) return null;

          const _id = new Types.ObjectId(item.productId);
          return {
            updateOne: {
              filter: { _id, stock: { $gte: qty } },
              update: { $inc: { stock: -qty } },
            },
          };
        })
        .filter(Boolean);

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
