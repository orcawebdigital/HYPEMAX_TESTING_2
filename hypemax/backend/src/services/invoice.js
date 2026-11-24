const PDFDocument = require("pdfkit");
const { getSettings } = require("./content");

const money = (p) => "Rs. " + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** Stream a PDF invoice for a paid order to `res`. Generated on demand, nothing stored on disk. */
async function streamInvoice(order, res) {
  const s = await getSettings();
  const doc = new PDFDocument({ size: "A4", margin: 44 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="HYPEMAX-Invoice-${order.order_number}.pdf"`);
  doc.pipe(res);

  const red = "#e01b1b", grey = "#666";
  doc.rect(0, 0, doc.page.width, 78).fill("#0b0b0b");
  doc.fillColor(red).font("Helvetica-Bold").fontSize(22).text("HYPEMAX", 44, 26, { continued: true }).fillColor("#fff").text(" Nutrition");
  doc.fillColor("#fff").font("Helvetica").fontSize(10).text(s.gstin ? "TAX INVOICE" : "INVOICE", 0, 34, { align: "right", width: doc.page.width - 44 });

  doc.fillColor("#000").fontSize(10).font("Helvetica-Bold").text("Sold by", 44, 100);
  const W = { width: 260 };
  doc.font("Helvetica").fillColor(grey)
    .text(s.legalName || "HYPEMAX NUTRITION", 44, undefined, W)
    .text(s.address || "", W)
    .text([s.email, s.phone].filter(Boolean).join("  |  "), W)
    .text(s.gstin ? "GSTIN: " + s.gstin : "", W);

  doc.fillColor("#000").font("Helvetica-Bold").text("Invoice details", 330, 100);
  doc.font("Helvetica").fillColor(grey)
    .text(`Invoice no: INV-${order.order_number}`, 330)
    .text(`Order no: ${order.order_number}`, 330)
    .text(`Order date: ${fmtDate(order.created_at)}`, 330)
    .text(`Paid on: ${order.paid_at ? fmtDate(order.paid_at) : "-"}`, 330);
  const pay = (order.payments || []).find((p) => p.razorpay_payment_id && p.status !== "failed");
  if (pay) doc.text(`Payment ID: ${pay.razorpay_payment_id}`, 330);

  doc.fillColor("#000").font("Helvetica-Bold").text("Ship to", 44, Math.max(200, doc.y + 14));
  doc.font("Helvetica").fillColor(grey)
    .text(order.ship_name, 44).text(order.ship_line1).text(order.ship_line2 || "")
    .text(`${order.ship_city}, ${order.ship_state} - ${order.ship_pincode}`).text(`Phone: ${order.ship_phone}`);

  let y = Math.max(290, doc.y + 24);
  const cols = [44, 270, 330, 400, 470];
  doc.rect(44, y - 6, doc.page.width - 88, 22).fill("#f2f2f2");
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(9);
  ["Item", "Qty", "MRP", "Price", "Amount"].forEach((h, i) => doc.text(h, cols[i], y, { width: i ? 70 : 220, align: i ? "right" : "left" }));
  y += 26;
  doc.font("Helvetica").fillColor("#222");
  for (const it of order.items) {
    const name = it.product_name + (it.flavour ? ` (${it.flavour})` : "");
    const h = doc.heightOfString(name, { width: 220 });
    doc.text(name, cols[0], y, { width: 220 });
    doc.text(String(it.quantity), cols[1], y, { width: 70, align: "right" });
    doc.text(money(it.unit_mrp), cols[2], y, { width: 70, align: "right" });
    doc.text(money(it.unit_price), cols[3], y, { width: 70, align: "right" });
    doc.text(money(it.line_total), cols[4], y, { width: 70, align: "right" });
    y += Math.max(h, 12) + 10;
  }
  doc.moveTo(44, y).lineTo(doc.page.width - 44, y).strokeColor("#ddd").stroke();
  y += 12;
  const row = (label, val, bold) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(bold ? "#000" : "#333").text(label, 330, y, { width: 130, align: "right" }).text(val, cols[4], y, { width: 70, align: "right" });
    y += 18;
  };
  row("Subtotal", money(order.subtotal));
  if (order.discount) row(`Coupon${order.coupon_code ? " (" + order.coupon_code + ")" : ""}`, "- " + money(order.discount));
  row("Shipping", order.shipping_fee ? money(order.shipping_fee) : "Free");
  row("Total paid", money(order.total), true);
  if (order.refunded_amount) row("Refunded", "- " + money(order.refunded_amount));
  y += 16;
  doc.font("Helvetica").fontSize(8).fillColor(grey).text("All prices are inclusive of applicable taxes. This is a computer-generated invoice and does not require a signature.", 44, y, { width: doc.page.width - 88 });
  doc.end();
}

module.exports = { streamInvoice };
