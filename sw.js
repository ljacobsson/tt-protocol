/* Shows the server's "match finished" notifications and opens the tournament
   when one is tapped. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try{ data = event.data ? event.data.json() : {}; }catch(e){}
  event.waitUntil(self.registration.showNotification(data.title || "Matchprotokoll", {
    body:data.body || "",
    tag:data.tag,
    data:{url:data.url || "/"}
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    const open = windows.find(client => client.url.split("#")[0] === url);
    // The tournament view only loads results on page load, so reload it.
    if (!open) return self.clients.openWindow(url);
    await open.focus();
    try{ await open.navigate(url); }catch(e){}
  })());
});
