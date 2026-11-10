# AquaMind teknik inceleme paketi

Bu klasör mevcut portalın dağıtımda kullanılan paketlenmiş arayüzünü, Worker sunucu şablonunu, D1 migrasyonlarını, SQLite şema örneğini ve gereksinim dokümanını içerir.

## Önemli sınırlar
- SQLite dosyası 10 Kasım 2026 tarihinde canlı D1’den salt okunur yolla alınmış anlık dışa aktarımı içerir. Liste kayıtları: müşteri 0, cihaz 0, servis 0, ürün 0, parça 8; History 137 satır.
- Proje kaynaklarında gerçek müşteri, cihaz, servis kayıtları veya kullanıcı parolaları bulunmadığından bunlar pakete eklenmemiştir.
- `worker/worker.template.js` Cloudflare Workers ve D1/R2 binding’lerine göre yazılmıştır; tek başına Node.js sunucusu değildir.
- `portal/index.html` mevcut arayüzün paketlenmiş halidir; arayüz bileşenleri ayrı kaynak dosyalara bölünmemiştir.

## Dosyalar
- `portal/index.html`: güncel dağıtım arayüzü
- `portal/aquamind-logo.png`: portal logosu
- `worker/worker.template.js`: sunucu/API şablonu
- `drizzle/*.sql`: mevcut D1 şema migrasyonları
- `AquaMind_Schema.sqlite`: kaynak migrasyonlarından türetilmiş, canlı D1 anlık verisi eklenmiş SQLite kopyası
- `AquaMind_Teknik_Envanter_ve_Gereksinimler.docx`: teknik açıklama ve gereksinim kataloğu

Portal: https://aquamind-servis-takip.paperypine.chatgpt.site
