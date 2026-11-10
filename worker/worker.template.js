const APP_HTML = __APP_HTML__;

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});
const now = () => new Date().toISOString();
const roles = new Set(["admin", "service_manager", "technician", "viewer"]);

function getIdentity(request) {
  const headers = request.headers;
  const accountId = headers.get("oai-authenticated-user-id") || "";
  const email = (headers.get("oai-authenticated-user-email") || "").trim().toLowerCase();
  let displayName = headers.get("oai-authenticated-user-full-name") || email;
  if (headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { displayName = decodeURIComponent(displayName); } catch {}
  }
  return accountId && email ? { accountId, email, displayName } : null;
}

async function resolveUser(request, env) {
  const identity = getIdentity(request);
  if (!identity) return { error: json({ error: "ChatGPT hesabıyla oturum açın.", signIn: "/signin-with-chatgpt?returnTo=%2F" }, 401) };
  let user = await env.DB.prepare("SELECT email, account_id, display_name, role, active FROM app_users WHERE account_id = ? OR email = ? COLLATE NOCASE LIMIT 1")
    .bind(identity.accountId, identity.email).first();
  if (!user) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM app_users").first();
    if (!Number(count?.total)) {
      const timestamp = now();
      await env.DB.prepare("INSERT INTO app_users (email, account_id, display_name, role, active, created_at, updated_at) VALUES (?, ?, ?, 'admin', 1, ?, ?)")
        .bind(identity.email, identity.accountId, identity.displayName, timestamp, timestamp).run();
      user = { ...identity, role: "admin", active: 1 };
    }
  } else if (!user.account_id && user.email.toLowerCase() === identity.email) {
    await env.DB.prepare("UPDATE app_users SET account_id = ?, display_name = ?, updated_at = ? WHERE email = ? COLLATE NOCASE AND account_id IS NULL")
      .bind(identity.accountId, identity.displayName, now(), identity.email).run();
    user.account_id = identity.accountId;
  }
  if (!user || !user.active || (user.account_id && user.account_id !== identity.accountId)) {
    return { error: json({ error: "Bu ChatGPT hesabına AquaMind uygulama erişimi tanımlanmamış. Sistem yöneticinize başvurun." }, 403) };
  }
  return { user: { ...user, account_id: identity.accountId, email: identity.email, display_name: user.display_name || identity.displayName } };
}

async function logAction(env, user, action, revision = 0) {
  let entityType = "system", entityId = "", details = action;
  const split = String(action).indexOf(":");
  if (split > 0) { entityType = String(action).slice(0, split); details = String(action).slice(split + 1); }
  await env.DB.prepare("INSERT INTO audit_log (account_id, email, action, revision, created_at, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(user.account_id, user.email, action, revision, now(), entityType, entityId, details).run();
}

async function hasPermission(env, user, permission) {
  if (user.role === "admin") return true;
  const row = await env.DB.prepare("SELECT permissions_json FROM app_roles WHERE role_key = ?").bind(user.role).first();
  let permissions = [];
  try { permissions = JSON.parse(row?.permissions_json || "[]"); } catch {}
  return permissions.includes(permission);
}

async function readState(env) {
  return env.DB.prepare("SELECT data_json, revision, updated_at FROM app_state WHERE id = 1").first();
}

function stateChanges(previous, next) {
  const changes = [];
  const collections = [["customers", "customer"], ["equipment", "device"], ["services", "service"], ["products", "product"], ["parts", "part"]];
  for (const [key, entity] of collections) {
    const before = new Map((Array.isArray(previous?.[key]) ? previous[key] : []).map(item => [String(item.id || item.code || ""), item]));
    const after = new Map((Array.isArray(next?.[key]) ? next[key] : []).map(item => [String(item.id || item.code || ""), item]));
    for (const [id, item] of after) {
      if (!before.has(id)) changes.push({ entity, id, action: "created", details: String(item.name || item.companyTitle || item.model || item.code || id).slice(0, 300) });
      else if (JSON.stringify(before.get(id)) !== JSON.stringify(item)) {
        const keys = [...new Set([...Object.keys(before.get(id) || {}), ...Object.keys(item || {})])].filter(k => JSON.stringify(before.get(id)?.[k]) !== JSON.stringify(item?.[k]));
        changes.push({ entity, id, action: "updated", details: "Değişen alanlar: " + keys.slice(0, 12).join(", ") });
      }
    }
    for (const [id, item] of before) if (!after.has(id)) changes.push({ entity, id, action: "deleted", details: String(item.name || item.companyTitle || item.model || item.code || id).slice(0, 300) });
  }
  if (JSON.stringify(previous?.siteSettings || {}) !== JSON.stringify(next?.siteSettings || {})) {
    changes.push({ entity: "design", id: "siteSettings", action: "updated", details: "Uygulama tasarım ayarları değiştirildi." });
  }
  return changes;
}

async function logStateChanges(env, user, previous, next, revision) {
  const timestamp = now(), changes = stateChanges(previous, next);
  if (!changes.length) return;
  await env.DB.batch(changes.map(item => env.DB.prepare("INSERT INTO audit_log (account_id, email, action, revision, created_at, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(user.account_id, user.email, item.action, revision, timestamp, item.entity, item.id, item.details)));
}

async function makeBackup(env, row, prefix = "manual") {
  if (!row || !env.BUCKET) return null;
  const stamp = now().replace(/[:.]/g, "-");
  const key = `${prefix}/${stamp}-r${row.revision}.json`;
  await env.BUCKET.put(key, row.data_json, { httpMetadata: { contentType: "application/json" } });
  return key;
}

async function maybeDailyBackup(env, row) {
  if (!row || !env.BUCKET) return;
  const date = now().slice(0, 10);
  const key = `daily/${date}.json`;
  if (!(await env.BUCKET.head(key))) {
    await env.BUCKET.put(key, row.data_json, { httpMetadata: { contentType: "application/json" } });
  }
}

async function api(request, env) {
  if (!env.DB || !env.BUCKET) return json({ error: "Ortak veritabanı veya yedekleme alanı yapılandırılmamış." }, 503);
  const path = new URL(request.url).pathname;
  const auth = await resolveUser(request, env);
  if (auth.error) return auth.error;
  const user = auth.user;

  if (path === "/api/session" && request.method === "GET") {
    const role = await env.DB.prepare("SELECT label, permissions_json FROM app_roles WHERE role_key = ?").bind(user.role).first();
    let permissions = [];
    try { permissions = JSON.parse(role?.permissions_json || "[]"); } catch {}
    if (user.role === "admin") permissions = ["view","edit_services","edit_customers","edit_equipment","edit_products","manage_design","manage_users","view_history","manage_backups"];
    await logAction(env, user, "session_started");
    return json({ user: { email: user.email, name: user.display_name, role: user.role, roleLabel: role?.label || user.role, permissions } });
  }
  if (path === "/api/audit" && request.method === "POST") {
    const payload = await request.json(), allowed = new Set(["excel_exported","json_backup_downloaded","service_report_opened"]);
    const action = String(payload?.action || ""), details = String(payload?.details || "").slice(0, 300);
    if (!allowed.has(action)) return json({ error: "İşlem türü geçersiz." }, 400);
    await env.DB.prepare("INSERT INTO audit_log (account_id, email, action, revision, created_at, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(user.account_id, user.email, action, Number((await readState(env))?.revision || 0), now(), "system", "", details).run();
    return json({ ok: true });
  }
  if (path === "/api/state" && request.method === "GET") {
    if (!(await hasPermission(env, user, "view"))) return json({ error: "Kayıtları görüntüleme yetkisi yok." }, 403);
    const row = await readState(env);
    return json({ data: row ? JSON.parse(row.data_json) : null, revision: Number(row?.revision || 0), updatedAt: row?.updated_at || null, user: { email: user.email, name: user.display_name, role: user.role } });
  }
  if (path === "/api/state" && request.method === "PUT") {
    const payload = await request.json();
    const data = payload?.data;
    const expected = Number(payload?.expectedRevision);
    if (!data || !Array.isArray(data.customers) || !Array.isArray(data.equipment) || !Array.isArray(data.services) || !Array.isArray(data.parts) || !Array.isArray(data.products)) {
      return json({ error: "Kayıt paketi geçersiz." }, 400);
    }
    const dataJson = JSON.stringify(data);
    if (dataJson.length > 5_000_000) return json({ error: "Veri paketi 5 MB sınırını aşıyor." }, 413);
    const current = await readState(env);
    const revision = Number(current?.revision || 0);
    if (revision !== expected) return json({ error: "Başka bir kullanıcı verileri güncelledi. Önce ortak verileri yenileyin.", revision }, 409);
    const previous = current ? JSON.parse(current.data_json) : null;
    const permissions = { customers: "edit_customers", equipment: "edit_equipment", services: "edit_services", products: "edit_products", parts: "edit_products", siteSettings: "manage_design" };
    for (const [key, permission] of Object.entries(permissions)) {
      if (JSON.stringify(data[key] ?? null) !== JSON.stringify(previous?.[key] ?? null) && !(await hasPermission(env, user, permission))) {
        return json({ error: "Bu işlem için gerekli yetki (" + permission + ") tanımlı değil." }, 403);
      }
    }
    await maybeDailyBackup(env, current);
    const timestamp = now(), nextRevision = revision + 1;
    if (current) {
      const result = await env.DB.prepare("UPDATE app_state SET data_json = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = 1 AND revision = ?")
        .bind(dataJson, nextRevision, user.email, timestamp, expected).run();
      if (!result.meta?.changes) return json({ error: "Başka bir kullanıcı verileri güncelledi. Önce ortak verileri yenileyin.", revision: nextRevision }, 409);
    } else {
      try {
        await env.DB.prepare("INSERT INTO app_state (id, data_json, revision, updated_by, updated_at) VALUES (1, ?, ?, ?, ?)")
          .bind(dataJson, nextRevision, user.email, timestamp).run();
      } catch {
        return json({ error: "Ortak veritabanı ilk kez başlatıldı; sayfayı yenileyin." }, 409);
      }
      await maybeDailyBackup(env, { data_json: dataJson, revision: nextRevision });
    }
    await logStateChanges(env, user, previous, data, nextRevision);
    await logAction(env, user, "state_saved", nextRevision);
    return json({ revision: nextRevision, updatedAt: timestamp });
  }
  if (path === "/api/users" && request.method === "GET") {
    if (!(await hasPermission(env, user, "manage_users"))) return json({ error: "Kullanıcı yönetimi yetkisi gerekir." }, 403);
    const result = await env.DB.prepare("SELECT email, account_id, display_name, role, active, created_at, updated_at FROM app_users ORDER BY email COLLATE NOCASE").all();
    return json({ users: result.results || [] });
  }
  if (path === "/api/users" && request.method === "PUT") {
    if (!(await hasPermission(env, user, "manage_users"))) return json({ error: "Kullanıcı yönetimi yetkisi gerekir." }, 403);
    const payload = await request.json();
    const email = String(payload?.email || "").trim().toLowerCase();
    const originalEmail = String(payload?.originalEmail || "").trim().toLowerCase();
    const role = String(payload?.role || "");
    const displayName = String(payload?.displayName || "").trim();
    const active = payload?.active === false ? 0 : 1;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !roles.has(role)) return json({ error: "E-posta veya rol geçersiz." }, 400);
    const timestamp = now();
    let current = originalEmail
      ? await env.DB.prepare("SELECT email, account_id, role FROM app_users WHERE email = ? COLLATE NOCASE").bind(originalEmail).first()
      : null;
    const existing = await env.DB.prepare("SELECT email, account_id, role FROM app_users WHERE email = ? COLLATE NOCASE").bind(email).first();
    if (originalEmail && !current) return json({ error: "Düzenlenecek kullanıcı bulunamadı. Listeyi yenileyin." }, 404);
    if (existing && current && existing.email.toLowerCase() !== current.email.toLowerCase()) return json({ error: "Bu e-posta adresi başka bir kullanıcıda kayıtlı." }, 409);
    if (!current) current = existing;
    if (current?.account_id && email !== current.email.toLowerCase()) return json({ error: "ChatGPT hesabına bağlanmış kullanıcıların e-posta adresi burada değiştirilemez. Yeni e-posta için ayrı kullanıcı oluşturun." }, 409);
    if (user.role !== "admin" && (role === "admin" || current?.role === "admin")) return json({ error: "Yalnızca sistem yöneticisi hesapları yönetici rolüne atayabilir." }, 403);
    if ((email === user.email || (current && current.email.toLowerCase() === user.email)) && (role !== "admin" || !active)) return json({ error: "Kendi yönetici erişiminizi kaldıramaz veya silemezsiniz." }, 400);
    if (current) {
      await env.DB.prepare("UPDATE app_users SET email = ?, display_name = ?, role = ?, active = ?, updated_at = ? WHERE email = ? COLLATE NOCASE")
        .bind(email, displayName, role, active, timestamp, current.email).run();
      await logAction(env, user, `user_updated:${email}`);
    } else {
      await env.DB.prepare("INSERT INTO app_users (email, display_name, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(email, displayName, role, active, timestamp, timestamp).run();
      await logAction(env, user, `user_created:${email}`);
    }
    return json({ ok: true });
  }
  if (path === "/api/users" && request.method === "DELETE") {
    if (!(await hasPermission(env, user, "manage_users"))) return json({ error: "Kullanıcı yönetimi yetkisi gerekir." }, 403);
    const payload = await request.json();
    const email = String(payload?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "E-posta adresi geçersiz." }, 400);
    const target = await env.DB.prepare("SELECT email, role FROM app_users WHERE email = ? COLLATE NOCASE").bind(email).first();
    if (!target) return json({ error: "Kullanıcı bulunamadı." }, 404);
    if (target.role === "admin") return json({ error: "Sistem yöneticisi hesabı silinemez." }, 400);
    if (email === user.email.toLowerCase()) return json({ error: "Kendi hesabınızı silemezsiniz." }, 400);
    await env.DB.prepare("DELETE FROM app_users WHERE email = ? COLLATE NOCASE").bind(target.email).run();
    await logAction(env, user, `user_deleted:${target.email}`);
    return json({ ok: true });
  }
  if (path === "/api/roles" && request.method === "GET") {
    if (!(await hasPermission(env, user, "manage_users"))) return json({ error: "Rol yönetimi yetkisi gerekir." }, 403);
    const result = await env.DB.prepare("SELECT role_key, label, permissions_json FROM app_roles ORDER BY role_key").all();
    return json({ roles: (result.results || []).map(row => ({ key: row.role_key, label: row.label, permissions: JSON.parse(row.permissions_json || "[]") })) });
  }
  if (path === "/api/roles" && request.method === "PUT") {
    if (user.role !== "admin") return json({ error: "Rol yönetimi için sistem yöneticisi yetkisi gerekir." }, 403);
    const payload = await request.json(), allowed = new Set(["view","edit_services","edit_customers","edit_equipment","edit_products","manage_design","manage_users","view_history","manage_backups"]);
    const roleKey = String(payload?.key || ""), permissions = payload?.permissions;
    if (!["service_manager","technician","viewer"].includes(roleKey) || !Array.isArray(permissions) || permissions.some(item => !allowed.has(item))) return json({ error: "Rol izinleri geçersiz." }, 400);
    if (!permissions.includes("view")) permissions.push("view");
    await env.DB.prepare("UPDATE app_roles SET permissions_json = ?, updated_at = ? WHERE role_key = ?").bind(JSON.stringify([...new Set(permissions)]), now(), roleKey).run();
    await logAction(env, user, "role_updated:" + roleKey);
    return json({ ok: true });
  }
  if (path === "/api/history" && request.method === "GET") {
    if (!(await hasPermission(env, user, "view_history"))) return json({ error: "İşlem geçmişi görüntüleme yetkisi gerekir." }, 403);
    const params = new URL(request.url).searchParams;
    const limit = Math.min(200, Math.max(1, Number(params.get("limit") || 100)));
    const offset = Math.max(0, Number(params.get("offset") || 0));
    const result = await env.DB.prepare("SELECT email, action, revision, created_at, entity_type, entity_id, details FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
    return json({ entries: result.results || [] });
  }
  if (path === "/api/backups" && request.method === "GET") {
    if (!(await hasPermission(env, user, "manage_backups"))) return json({ error: "Merkezi yedekleri yönetme yetkisi gerekir." }, 403);
    const listed = await env.BUCKET.list({ prefix: "", limit: 1000 });
    return json({ backups: (listed.objects || []).map(x => ({ key: x.key, uploaded: x.uploaded?.toISOString?.() || "", size: x.size })).sort((a, b) => b.key.localeCompare(a.key)).slice(0, 100) });
  }
  if (path === "/api/backups" && request.method === "POST") {
    if (!(await hasPermission(env, user, "manage_backups"))) return json({ error: "Merkezi yedekleri yönetme yetkisi gerekir." }, 403);
    const row = await readState(env);
    const key = await makeBackup(env, row);
    if (!key) return json({ error: "Ortak veritabanında henüz yedeklenecek kayıt yok." }, 404);
    await logAction(env, user, `backup_created:${key}`, Number(row.revision));
    return json({ key });
  }
  if (path === "/api/backups/restore" && request.method === "POST") {
    if (!(await hasPermission(env, user, "manage_backups"))) return json({ error: "Merkezi yedekleri yönetme yetkisi gerekir." }, 403);
    const { key, expectedRevision } = await request.json();
    if (typeof key !== "string" || !/^(daily|manual|pre-restore)\/[a-zA-Z0-9._-]+\.json$/.test(key)) return json({ error: "Yedek dosyası geçersiz." }, 400);
    const current = await readState(env);
    if (Number(current?.revision || 0) !== Number(expectedRevision)) return json({ error: "Ortak veriler değişti. Yenileyip tekrar deneyin." }, 409);
    const object = await env.BUCKET.get(key);
    if (!object) return json({ error: "Yedek dosyası bulunamadı." }, 404);
    const restored = await object.text();
    const parsed = JSON.parse(restored);
    if (!parsed || !Array.isArray(parsed.customers) || !Array.isArray(parsed.services)) return json({ error: "Yedek içeriği geçersiz." }, 400);
    await makeBackup(env, current, "pre-restore");
    const timestamp = now(), revision = Number(current?.revision || 0) + 1;
    const update = await env.DB.prepare("UPDATE app_state SET data_json = ?, revision = ?, updated_by = ?, updated_at = ? WHERE id = 1 AND revision = ?")
      .bind(restored, revision, user.email, timestamp, Number(expectedRevision)).run();
    if (!update.meta?.changes) return json({ error: "Ortak veriler değişti. Yenileyip tekrar deneyin." }, 409);
    await logAction(env, user, `backup_restored:${key}`, revision);
    return json({ revision, updatedAt: timestamp });
  }
  return json({ error: "API yolu bulunamadı." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": url.origin, "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
      try { return await api(request, env); }
      catch (error) { return json({ error: "Sunucu işlemi tamamlayamadı.", detail: String(error?.message || error) }, 500); }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(APP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/aquamind-logo.png") {
      return new Response(__LOGO_BYTES__, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
