const express = require("express");
const Products = require("./products.model");
const Reviews = require("../reviews/reviews.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const { uploadImages } = require("../utils/uploadImage");
const multer = require("multer");

const router = express.Router();
const upload = multer(); // memory storage

// ====================== البحث ======================
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    const products = await Products.find({
      $or: [
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
      ],
    }).limit(20);
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: "فشل البحث" });
  }
});

// ====================== رفع صور ======================
router.post("/uploadImages", async (req, res) => {
  try {
    const { images } = req.body; // base64[]
    if (!images || !Array.isArray(images)) {
      return res.status(400).send({ message: "يجب إرسال مصفوفة من الصور" });
    }
    const uploadedUrls = await uploadImages(images);
    res.status(200).send(uploadedUrls);
  } catch (error) {
    console.error("Error uploading images:", error);
    res.status(500).send({ message: "حدث خطأ أثناء تحميل الصور" });
  }
});

// ====================== إنشاء منتج ======================
router.post("/create-product", async (req, res) => {
  try {
    let {
      name,
      mainCategory,
      category,
      description,
      oldPrice,
      price,
      image,
      author,
      stock,
    } = req.body;

    if (price !== undefined) price = Number(price);
    if (oldPrice !== undefined && oldPrice !== "") oldPrice = Number(oldPrice);
    else oldPrice = undefined;

    if (stock === undefined || stock === null || stock === "") {
      stock = 0;
    } else {
      stock = Math.floor(Number(stock));
    }

    if (!name || !mainCategory || !category || !description || price == null || !author) {
      return res.status(400).send({
        message:
          "جميع الحقول المطلوبة يجب إرسالها (الاسم، الفئة الرئيسية، النوع، الوصف، السعر، المؤلف)",
      });
    }

    if (Number.isNaN(price) || price < 0) {
      return res.status(400).send({ message: "السعر غير صالح" });
    }

    if (Number.isNaN(stock) || stock < 0) {
      return res.status(400).send({ message: "قيمة المخزون (stock) غير صالحة" });
    }

    if (!image || (Array.isArray(image) && image.length === 0)) {
      return res.status(400).send({ message: "يجب إرسال صورة واحدة على الأقل" });
    }

    const normalizedImages = Array.isArray(image) ? image : [image];

    const productData = {
      name: String(name).trim(),
      mainCategory: String(mainCategory).trim(),
      category: String(category).trim(),
      description: String(description).trim(),
      price,
      oldPrice,
      image: normalizedImages,
      author,
      stock,
    };

    const newProduct = new Products(productData);
    const savedProduct = await newProduct.save();
    return res.status(201).send(savedProduct);
  } catch (error) {
    console.error("Error creating new product", error);
    return res.status(500).send({ message: "Failed to create new product" });
  }
});

// ====================== كل المنتجات ======================
router.get("/", async (req, res) => {
  try {
    const { category, size, color, minPrice, maxPrice, page = 1, limit = 10 } = req.query;

    const filter = {};
    if (category && category !== "all") {
      filter.category = category;
      if (category === "حناء بودر" && size) {
        filter.size = size;
      }
    }
    if (color && color !== "all") {
      filter.color = color;
    }
    if (minPrice && maxPrice) {
      const min = parseFloat(minPrice);
      const max = parseFloat(maxPrice);
      if (!isNaN(min) && !isNaN(max)) {
        filter.price = { $gte: min, $lte: max };
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalProducts = await Products.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    const products = await Products.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("author", "email")
      .sort({ createdAt: -1 });

    res.status(200).send({ products, totalPages, totalProducts });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});

// ====================== المنتجات المرتبطة (ضعه قبل /:id) ======================
router.get("/related/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).send({ message: "Product ID is required" });

    const product = await Products.findById(id);
    if (!product) return res.status(404).send({ message: "Product not found" });

    const titleRegex = new RegExp(
      product.name
        .split(" ")
        .filter((word) => word.length > 1)
        .join("|"),
      "i"
    );

    const relatedProducts = await Products.find({
      _id: { $ne: id },
      $or: [{ name: { $regex: titleRegex } }, { category: product.category }],
    });

    res.status(200).send(relatedProducts);
  } catch (error) {
    console.error("Error fetching the related products", error);
    res.status(500).send({ message: "Failed to fetch related products" });
  }
});

// ====================== منتج واحد ======================
// ندعم /product/:id (للـfrontend) وكذلك /:id، لكن احرص أن يأتيان بعد /related/:id
router.get(["/product/:id", "/:id"], async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await Products.findById(productId).populate("author", "email username");
    if (!product) return res.status(404).send({ message: "Product not found" });

    const reviews = await Reviews.find({ productId }).populate("userId", "username email");

    res.status(200).send({ product, reviews });
  } catch (error) {
    console.error("Error fetching the product", error);
    res.status(500).send({ message: "Failed to fetch the product" });
  }
});

// ====================== تحديث منتج ======================
router.patch(
  "/update-product/:id",
  verifyToken,
  verifyAdmin,
  upload.none(), // نستقبل فورم-داتا بدون ملفات (حقول فقط)
  async (req, res) => {
    try {
      const productId = req.params.id;

      let {
        name,
        mainCategory,
        category,
        price,
        oldPrice,
        description,
        author,
        stock, // ✅ دعم تحديث المخزون
      } = req.body;

      // تحويلات رقمية آمنة
      const priceNum = price !== undefined ? Number(price) : undefined;
      const oldPriceNum =
        oldPrice !== undefined && oldPrice !== "" ? Number(oldPrice) : undefined;
      const stockNum =
        stock !== undefined && stock !== "" ? Math.floor(Number(stock)) : undefined;

      // تحقق المدخلات المطلوبة (حسب واجهتك أنت ترسل كل الحقول)
      if (
        !name ||
        !mainCategory ||
        !category ||
        priceNum == null ||
        !description
      ) {
        return res.status(400).send({
          message:
            "جميع الحقول المطلوبة يجب إرسالها (الاسم، الفئة الرئيسية، النوع، السعر، الوصف)",
        });
      }

      if (Number.isNaN(priceNum) || priceNum < 0) {
        return res.status(400).send({ message: "السعر غير صالح" });
      }
      if (oldPriceNum !== undefined && (Number.isNaN(oldPriceNum) || oldPriceNum < 0)) {
        return res.status(400).send({ message: "السعر القديم غير صالح" });
      }
      if (stockNum !== undefined && (Number.isNaN(stockNum) || stockNum < 0)) {
        return res.status(400).send({ message: "قيمة المخزون (stock) غير صالحة" });
      }

      // تجهيز بيانات التحديث مع trim
      const updateData = {
        name: String(name).trim(),
        mainCategory: String(mainCategory).trim(),
        category: String(category).trim(),
        price: priceNum,
        description: String(description).trim(),
      };

      if (author) updateData.author = author;
      if (oldPriceNum !== undefined) updateData.oldPrice = oldPriceNum; // فقط لو أُرسل فعلاً
      if (stockNum !== undefined) updateData.stock = stockNum; // فقط لو أُرسل فعلاً

      // ====== الصور (اختيارية) ======
      // دعم ثلاث حالات:
      // 1) image[] = [url1, url2, ...]
      // 2) image = 'url' أو تكرر image عدة مرات (نحاول تجميعها يدويًا)
      // 3) imageJson = '["url1","url2"]'
      const imagesFieldArray = [];
      const body = req.body;

      // حالة image[] من فورم-داتا
      if (Array.isArray(body["image[]"])) {
        imagesFieldArray.push(...body["image[]"]);
      }

      // حالة تكرار image
      if (Array.isArray(body.image)) {
        imagesFieldArray.push(...body.image);
      } else if (typeof body.image === "string" && body.image.trim() !== "") {
        imagesFieldArray.push(body.image.trim());
      }

      // حالة JSON نصّي
      if (typeof body.imageJson === "string" && body.imageJson.trim() !== "") {
        try {
          const parsed = JSON.parse(body.imageJson);
          if (Array.isArray(parsed)) {
            imagesFieldArray.push(...parsed.filter(Boolean));
          }
        } catch (_) {
          // تجاهل JSON غير صالح
        }
      }

      // إزالة التكرارات وفراغات
      const normalizedImages = [...new Set(imagesFieldArray.map(String))].filter(
        (u) => u && u.trim() !== ""
      );

      if (normalizedImages.length > 0) {
        updateData.image = normalizedImages;
      }
      // إن لم تُرسل صور نهائيًا لا نضع image في $set حتى لا نمسح القديمة

      const updatedProduct = await Products.findByIdAndUpdate(
        productId,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      if (!updatedProduct) {
        return res.status(404).send({ message: "المنتج غير موجود" });
      }

      res.status(200).send({
        message: "تم تحديث المنتج بنجاح",
        product: updatedProduct,
      });
    } catch (error) {
      console.error("خطأ في تحديث المنتج", error);
      res.status(500).send({
        message: "فشل تحديث المنتج",
        error: error.message,
      });
    }
  }
);


// ====================== حذف منتج ======================
router.delete("/:id", async (req, res) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Products.findByIdAndDelete(productId);

    if (!deletedProduct) {
      return res.status(404).send({ message: "Product not found" });
    }

    await Reviews.deleteMany({ productId });
    res.status(200).send({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting the product", error);
    res.status(500).send({ message: "Failed to delete the product" });
  }
});

module.exports = router;
