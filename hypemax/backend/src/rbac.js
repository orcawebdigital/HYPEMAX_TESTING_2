// Role-based access control definitions. Seeded into MySQL (roles, permissions, role_permissions).
const PERMISSIONS = {
  "dashboard.view": "View dashboard overview",
  "analytics.view": "View analytics and reports",
  "products.manage": "Create/delete products, change prices, stock and availability",
  "products.content": "Edit product descriptions, images and detail sections",
  "orders.view": "View orders",
  "orders.manage": "Update order status and shipping",
  "orders.refund": "Cancel orders and issue refunds",
  "customers.view": "View customers",
  "customers.export": "Export customer and order data",
  "coupons.manage": "Manage coupons",
  "content.manage": "Edit website content, banners, FAQs and policies",
  "reviews.manage": "Moderate reviews and testimonials",
  "messages.manage": "Handle contact messages and newsletter list",
  "admins.manage": "Create admins and assign roles",
  "audit.view": "View admin audit log",
};

const ROLES = {
  super_admin: { name: "Super Admin", perms: Object.keys(PERMISSIONS) },
  manager: {
    name: "Manager",
    perms: ["dashboard.view", "analytics.view", "products.manage", "products.content", "orders.view", "orders.manage", "orders.refund",
      "customers.view", "customers.export", "coupons.manage", "reviews.manage", "messages.manage"],
  },
  content_manager: { name: "Content Manager", perms: ["dashboard.view", "products.content", "content.manage", "reviews.manage"] },
  order_manager: { name: "Order Manager", perms: ["dashboard.view", "orders.view", "orders.manage", "customers.view", "messages.manage"] },
};

async function syncRbac(conn) {
  const { q } = require("./db");
  for (const [slug, name] of Object.entries(PERMISSIONS))
    await q("INSERT INTO permissions (slug, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)", [slug, name], conn);
  for (const [slug, r] of Object.entries(ROLES)) {
    await q("INSERT INTO roles (slug, name) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)", [slug, r.name], conn);
    const [{ id }] = await q("SELECT id FROM roles WHERE slug=?", [slug], conn);
    await q("DELETE FROM role_permissions WHERE role_id=?", [id], conn);
    await q("INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE slug IN (?)", [id, r.perms], conn);
  }
}

module.exports = { PERMISSIONS, ROLES, syncRbac };
