// Daily keep-alive so the free Supabase project is never paused for inactivity.
export default async function handler(req, res) {
  const r = await fetch("https://bmvoqeriqhcaxweuqjdz.supabase.co/rest/v1/rpc/ping", {
    method: "POST",
    headers: { apikey: "sb_publishable_qDk-n67dGD4P5DmA4yQZ2g_653PbTlw", "Content-Type": "application/json" },
    body: "{}",
  });
  res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status });
}
