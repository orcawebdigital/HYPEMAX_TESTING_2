/**
 * Idempotent seed: roles/permissions always sync; catalog/content only inserted when empty.
 * Product facts below are transcribed from the HYPEMAX Pre-Workout packaging label.
 */
const path = require("path");
const fs = require("fs");
const config = require("./config");
const { q, one, tx } = require("./db");
const { syncRbac } = require("./rbac");
const { hashPassword } = require("./auth");
const cloud = require("./services/cloudinary");

const IMG_DIR = path.join(__dirname, "..", "..", "frontend", "img", "products");
const PRE_WORKOUT_IMAGES = [
  ["pre-workout-front.jpg", "HYPEMAX Pre-Workout 300g tub, Fruit Punch flavour"],
  ["pre-workout-angle.jpg", "HYPEMAX Pre-Workout tub, angled view"],
  ["pre-workout-label-front.jpg", "HYPEMAX Pre-Workout front label: 1810mg Beta Alanine, 4000mg L-Citrulline, 180mg Caffeine, 1000mg L-Tyrosine"],
  ["pre-workout-nutrition.jpg", "HYPEMAX Pre-Workout nutrition facts and directions"],
  ["pre-workout-back.jpg", "HYPEMAX Pre-Workout tub, back label"],
  ["pre-workout-label-back.jpg", "HYPEMAX Pre-Workout back label: advisory, warnings, storage and FSSAI licence"],
  ["pre-workout-collage.jpg", "HYPEMAX Pre-Workout product photos"],
];

const NUTRITION = `Serving size: 1 scoop (5 g, 60 servings) or 2 scoops (10 g, 30 servings)
Nutrient | Per 100 g | Per 5 g | Per 10 g
Energy (kcal) | 48 | 2.4 | 4.8
Protein (g) | 0 | 0 | 0
Carbohydrate (g) | 12 | 0.6 | 0.12
Total sugars (g) | 2.8 | 0.14 | 0.28
Added sugars (g) | 0 | 0 | 0
Total fat (g) | 0 | 0 | 0
Sodium | 46 mg | 2.3 mg | 4.6 mg
L-Citrulline DL-Malate | 40000 mg | 2000 mg | 4000 mg
Beta-Alanine | 18100 mg | 905 mg | 1810 mg
L-Tyrosine | 10000 mg | 500 mg | 1000 mg
L-Arginine | 10000 mg | 500 mg | 1000 mg
Betaine Anhydrous | 5000 mg | 250 mg | 500 mg
Taurine | 3000 mg | 150 mg | 300 mg
Caffeine Anhydrous | 1800 mg | 90 mg | 180 mg
L-Theanine | 500 mg | 25 mg | 50 mg
Green Tea Extract | 300 mg | 15 mg | 30 mg
Black Pepper Extract | 30 mg | 1.5 mg | 3 mg
%RDA values established as per ICMR guidelines, 2020, for a 2000 kcal diet. RDA not established for the amino acids and extracts listed.`;

const SECTIONS = [
  ["Ingredients", `- L-Citrulline DL-Malate
- Beta-Alanine
- L-Tyrosine
- L-Arginine
- Betaine Anhydrous
- Taurine
- Caffeine Anhydrous
- L-Theanine
- Green Tea Extract
- Black Pepper Extract

Other ingredients: Citric Acid (INS 330), Monk Fruit, Fruit Punch Flavour, Himalayan Pink Salt, Silicone Dioxide (INS 551), Sucralose (INS 955).
Contains added sweetener sucralose.`],
  ["Benefits", `As stated on the pack:
- Laser focus
- Explosive energy
- Maximum performance
- Supports energy levels and metabolism
- Supports body composition and weight management goals when combined with a proper diet
- Zero added sugar

Made for sports athletes, fitness enthusiasts, bodybuilders, endurance runners, cyclists and beginners.`],
  ["How to Use", `- Mix 1 scoop (5 g) or 2 scoops (10 g) with 220-250 ml of ice-cold water.
- Shake well for about 10 seconds until dissolved.
- Consume 15-30 minutes before intense exercise.
- Limit use to once per day. Do not exceed the recommended daily usage.`],
  ["Product Specifications", `Net weight | 300 g
Flavour | Fruit Punch
Servings | 30 (2 scoops / 10 g) or 60 (1 scoop / 5 g)
Form | Powder
Product type | Dietary supplement (nutraceutical product)
Manufactured by | Gomzi Life Science LLP, Surat, Gujarat
Marketed by | HYPEMAX Nutrition, Gomti Nagar Extension, Lucknow
FSSAI Lic. No. | 10724997000182
Country of origin | India`],
  ["Nutritional Information", NUTRITION],
  ["Storage Instructions", `Store in a dry, hygienic place below 25°C.
Keep away from direct sunlight.
Keep out of reach of children.`],
  ["Safety & Warnings", `- Contains caffeine. Individuals with caffeine intolerance should not consume this product.
- High stimulant content. Not recommended for beginners or individuals sensitive to caffeine.
- Consult a healthcare practitioner before use if you are pregnant, nursing, have liver disease, or have been instructed to follow a low-protein diet.
- Not recommended for children. Not for medicinal use.`],
  ["Frequently Asked Questions", `How much caffeine is in one serving?
A 2-scoop (10 g) serving contains 180 mg caffeine. A 1-scoop (5 g) serving contains 90 mg.

When should I take it?
15-30 minutes before your workout, no more than once per day.

Does it contain added sugar?
No. It contains 0 g added sugar and is sweetened with sucralose and monk fruit.`],
];

const FAQS = [
  ["What is HYPEMAX Pre-Workout?", "A Fruit Punch flavoured pre-workout from HYPEMAX Nutrition with L-Citrulline, Beta-Alanine, L-Tyrosine and caffeine, made for training energy, focus and performance. Each 300 g tub has 30 servings of 10 g."],
  ["How do I place an order?", "Add the product to your cart, log in or create an account, choose your delivery address and pay securely online through Razorpay (UPI, cards, net banking and wallets). You'll get an order confirmation once payment is verified."],
  ["Is online payment secure?", "Yes. Payments are processed by Razorpay. We never see or store your card or UPI details."],
  ["How can I track my order?", "Log in and open My Account → Orders. Tracking details appear there as soon as your order ships."],
  ["Can I cancel my order?", "You can cancel from My Account before the order is packed. The amount is refunded to your original payment method."],
  ["How do I contact support?", "Email Customercare@hypemaxnutrition.in or WhatsApp 9984472222."],
];

const POLICIES = {
  policy_privacy: { title: "Privacy Policy", body: `## What we collect
When you create an account or place an order we collect your name, email, phone number and delivery address. Payments are processed by Razorpay; we receive a payment reference but never your card or UPI details.

## How we use it
We use your details to process and deliver orders, provide customer support and send order updates. We only send marketing emails if you subscribe to our newsletter.

## Analytics
We use our own privacy-friendly analytics to understand how the website is used (pages viewed, device type, how visitors found us). We do not sell your data or use third-party advertising trackers. If your browser sends a Do Not Track or Global Privacy Control signal, we do not record analytics for you.

## Your choices
You can update your profile and addresses from My Account, unsubscribe from emails at any time, and contact us to request deletion of your account.` },
  policy_terms: { title: "Terms & Conditions", body: `## Using this website
By using this website you agree to these terms. Product information is provided for general information and is not medical advice. Read the label and warnings before use.

## Orders and pricing
All prices are in Indian Rupees and include applicable taxes. An order is confirmed only after payment is successfully verified. We may cancel an order and issue a full refund if a product becomes unavailable or a pricing error occurs.

## Coupons
Coupons are subject to their stated conditions (validity, minimum order value, usage limits) and cannot be exchanged for cash.

## Contact
For any questions about these terms, contact Customercare@hypemaxnutrition.in.` },
  policy_shipping: { title: "Shipping Policy", body: `## Where we ship
We currently ship across India.

## Dispatch and delivery
Orders are usually dispatched within 1-2 working days after payment confirmation. Delivery typically takes 3-7 working days depending on your location.

## Tracking
Once your order ships, the courier name and tracking ID appear in My Account → Orders.` },
  policy_refund: { title: "Return & Refund Policy", body: `## Cancellations
You can cancel an order from My Account before it is packed. Paid orders are refunded in full to the original payment method.

## Returns
For hygiene and safety reasons, opened supplement products cannot be returned. If you receive a damaged, incorrect or tampered product, contact us within 48 hours of delivery with photos of the product and packaging and we'll arrange a replacement or refund.

## Refund timelines
Approved refunds are initiated within 2 working days and are usually credited to your original payment method within 5-7 working days.` },
};

async function seedImages(productId, folderSlug) {
  for (const [i, [file, alt]] of PRE_WORKOUT_IMAGES.entries()) {
    const local = path.join(IMG_DIR, file);
    if (!fs.existsSync(local)) continue;
    let url = `/img/products/${file}`, public_id = null, width = null, height = null;
    if (config.features.cloudinary) {
      const up = await cloud.uploadPath(local, `products/${folderSlug}`);
      ({ url, public_id, width, height } = up);
    }
    await q("INSERT INTO images (owner_type, owner_id, public_id, url, width, height, category, alt_text, sort_order) VALUES ('product',?,?,?,?,?,'gallery',?,?)",
      [productId, public_id, url, width, height, alt, i]);
  }
}

async function seed({ log = console.log } = {}) {
  await tx((conn) => syncRbac(conn));

  if (!(await one("SELECT id FROM admins LIMIT 1")) && config.bootstrapAdmin.email && config.bootstrapAdmin.password) {
    const role = await one("SELECT id FROM roles WHERE slug='super_admin'");
    await q("INSERT INTO admins (name, email, password_hash, role_id) VALUES (?,?,?,?)",
      [config.bootstrapAdmin.name, config.bootstrapAdmin.email.toLowerCase(), await hashPassword(config.bootstrapAdmin.password), role.id]);
    log(`Created Super Admin ${config.bootstrapAdmin.email}`);
  }

  if (!(await one("SELECT id FROM categories LIMIT 1"))) {
    for (const [i, [name, slug, d]] of [["Pre-Workout", "pre-workout", "Energy, focus and performance before training."], ["Protein", "protein", "Protein for recovery and muscle building."], ["Creatine", "creatine", "Creatine for strength and power."]].entries())
      await q("INSERT INTO categories (name, slug, description, sort_order) VALUES (?,?,?,?)", [name, slug, d, i]);
    log("Seeded categories");
  }

  if (!(await one("SELECT id FROM products LIMIT 1"))) {
    const cat = async (s) => (await one("SELECT id FROM categories WHERE slug=?", [s])).id;
    const r = await q(`INSERT INTO products (category_id, name, slug, sku, status, short_description, description, highlights, flavours, net_weight, servings, mrp, price, featured, sort_order, meta_title, meta_description)
      VALUES (?,?,?,?, 'active', ?,?,?,?, '300 g', '30 servings', 189900, 149900, 1, 1, ?, ?)`, [
      await cat("pre-workout"), "HYPEMAX Pre-Workout", "hypemax-pre-workout", "HM-PW-300-FP",
      "Energy. Focus. Performance. Fruit Punch flavour, 300 g, 30 servings.",
      "HYPEMAX Pre-Workout is built for the sessions that matter. Each 10 g serving delivers 4000 mg L-Citrulline, 1810 mg Beta-Alanine, 1000 mg L-Tyrosine and 180 mg caffeine for laser focus, explosive energy and maximum performance. Zero added sugar, great-tasting Fruit Punch flavour, made in India.",
      JSON.stringify(["4000 mg L-Citrulline", "1810 mg Beta-Alanine", "180 mg Caffeine", "1000 mg L-Tyrosine", "30 servings per tub", "0 g added sugar"]),
      JSON.stringify(["Fruit Punch"]),
      "HYPEMAX Pre-Workout (Fruit Punch, 300 g) | HYPEMAX Nutrition",
      "Buy HYPEMAX Pre-Workout online: 4000 mg L-Citrulline, 1810 mg Beta-Alanine, 180 mg caffeine per serving. 30 servings, Fruit Punch flavour. Secure checkout.",
    ]);
    const pid = r.insertId;
    // NOTE: placeholder opening stock. Set the real stock in Admin → Products before launch.
    await q("INSERT INTO inventory (product_id, stock, low_stock_threshold) VALUES (?, 50, 10)", [pid]);
    await q("INSERT INTO inventory_movements (product_id, change_qty, reason) VALUES (?, 50, 'initial seed')", [pid]);
    for (const [i, [t, c]] of SECTIONS.entries()) await q("INSERT INTO product_sections (product_id, title, content, sort_order) VALUES (?,?,?,?)", [pid, t, c, i]);
    await seedImages(pid, "hypemax-pre-workout");

    for (const [name, slug, catSlug, status, sort, short] of [
      ["HYPEMAX Whey Protein", "hypemax-whey-protein", "protein", "upcoming", 2, "Premium whey protein for recovery and lean muscle. Launching soon."],
      ["HYPEMAX Creatine", "hypemax-creatine", "creatine", "coming_soon", 3, "Pure creatine monohydrate for strength and power. Launching soon."],
    ]) {
      const x = await q("INSERT INTO products (category_id, name, slug, status, short_description, sort_order) VALUES (?,?,?,?,?,?)", [await cat(catSlug), name, slug, status, short, sort]);
      await q("INSERT INTO inventory (product_id, stock) VALUES (?, 0)", [x.insertId]);
    }
    log("Seeded products");
  }

  if (!(await one("SELECT id FROM faqs LIMIT 1"))) {
    for (const [i, [qq, a]] of FAQS.entries()) await q("INSERT INTO faqs (question, answer, sort_order) VALUES (?,?,?)", [qq, a, i]);
    log("Seeded FAQs");
  }

  const content = {
    settings: {
      brandName: "HYPEMAX Nutrition", legalName: "HYPEMAX NUTRITION", email: "Customercare@hypemaxnutrition.in", phone: "9984472222", whatsapp: "919984472222",
      address: "C17/3, Sector 6, Gomti Nagar Extension, Lucknow, Uttar Pradesh", footerText: "Premium sports nutrition for people who train with intent.",
      announcement: "", seoTitle: "HYPEMAX Nutrition | Unleash Your Max Potential",
      seoDescription: "Premium sports nutrition from HYPEMAX Nutrition. Shop HYPEMAX Pre-Workout for energy, focus and performance.",
      shippingFee: "0", freeShippingAbove: "0", deliveryEstimate: "", businessHours: "",
    },
    homepage: {
      heroEyebrow: "Premium sports nutrition", heroTitle: "UNLEASH YOUR MAX POTENTIAL.",
      heroText: "Fuel your ambition. Elevate your performance. Experience the next level of training with HYPEMAX Nutrition.",
      heroCtaLabel: "Shop now",
      introTitle: "Built for those who push beyond limits.",
      introText: "HYPEMAX Nutrition is a performance-focused sports nutrition brand for dedicated training enthusiasts. We believe you should know exactly what goes into your scoop: transparent ingredient information, premium quality and formulas designed around training energy and focus.",
      productsTitle: "Shop HYPEMAX", productsSubtitle: "Performance nutrition, made in India.",
      comingSoonTitle: "The next level is coming.",
      whyTitle: "Why HYPEMAX",
      why: [
        { title: "Transparent ingredients", text: "Every active and its dose is on the label and on this website." },
        { title: "Performance-focused formula", text: "4000 mg L-Citrulline, 1810 mg Beta-Alanine and 180 mg caffeine per serving." },
        { title: "Zero added sugar", text: "Sweetened with sucralose and monk fruit. Great Fruit Punch taste." },
        { title: "FSSAI licensed", text: "Manufactured in India under FSSAI licence 10724997000182." },
      ],
      stats: [{ title: "30", text: "servings per tub" }, { title: "4000mg", text: "L-Citrulline per serving" }, { title: "0g", text: "added sugar" }],
      ctaTitle: "Your next session starts here.", ctaText: "Secure online payment. Fast delivery across India.",
      testimonialsTitle: "What athletes say", newsletterTitle: "Join the HYPEMAX crew", newsletterText: "Launch news for Whey Protein and Creatine, plus subscriber-only offers.",
    },
    about: {
      title: "Our story",
      intro: "HYPEMAX Nutrition makes performance-focused sports nutrition for people who train hard and want straight answers about what they take.",
      body: "We started HYPEMAX Nutrition with a simple idea: supplements should be honest. Every product we make lists its actives and doses clearly, is manufactured under FSSAI licence, and is designed around what athletes actually need before, during and after training.\n\nHYPEMAX Pre-Workout is our first product. Whey Protein and Creatine are on the way.",
      values: [
        { title: "Transparent by default", text: "We share ingredient information openly so you can decide with confidence." },
        { title: "Built for training", text: "Formulated around energy, focus and performance for gym and endurance athletes." },
        { title: "Made in India", text: "Manufactured in India by an FSSAI-licensed manufacturer (Lic. No. 10724997000182)." },
        { title: "Direct support", text: "Talk to our team on WhatsApp or email for orders, delivery and questions." },
      ],
    },
    contact: { title: "Get in touch", intro: "Questions about HYPEMAX, your order or delivery? Send us a message or reach us on WhatsApp.", hours: "" },
    ...POLICIES,
  };
  for (const [k, v] of Object.entries(content)) {
    if (!(await one("SELECT content_key FROM site_content WHERE content_key=?", [k]))) await q("INSERT INTO site_content (content_key, value) VALUES (?,?)", [k, JSON.stringify(v)]);
  }
}

/** Move any locally-referenced images (seeded in development) to Cloudinary. */
async function uploadSeedImages({ log = console.log } = {}) {
  if (!config.features.cloudinary) throw new Error("Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET first");
  const rows = await q("SELECT i.id, i.url, p.slug FROM images i LEFT JOIN products p ON p.id=i.owner_id AND i.owner_type='product' WHERE i.public_id IS NULL AND i.url LIKE '/img/%'");
  for (const r of rows) {
    const local = path.join(__dirname, "..", "..", "frontend", r.url);
    if (!fs.existsSync(local)) { log(`skip ${r.url} (file missing)`); continue; }
    const up = await cloud.uploadPath(local, r.slug ? `products/${r.slug}` : "content");
    await q("UPDATE images SET url=?, public_id=?, width=?, height=? WHERE id=?", [up.url, up.public_id, up.width, up.height, r.id]);
    log(`uploaded ${r.url} -> ${up.url}`);
  }
}

module.exports = { seed, uploadSeedImages };
