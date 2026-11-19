# Flow Music UI â€” tiáº¿n Ä‘á»™

## BÆ°á»›c 1 Â· Design gate (19/11/2026) â€” CHá»œ OWNER DUYá»†T
- Prototype báº¥m thá»­: `docs/design/flow-music/prototype.html` (má»Ÿ tháº³ng báº±ng Chrome; thanh "Mockup" gÃ³c pháº£i dÆ°á»›i Ä‘á»ƒ Ä‘á»•i tráº¡ng thÃ¡i: cÃ³ dá»¯ liá»‡u / trá»‘ng / Ä‘ang táº£i / lá»—i / chÆ°a cÃ³ tÃ i khoáº£n; nÃºt Giao diá»‡n sÃ¡ng/tá»‘i á»Ÿ sidebar).
- áº¢nh chá»¥p: `docs/design/flow-music/shots/` â€” 44 áº£nh, 390/768/1024/1366/1920 Ã— sÃ¡ng/tá»‘i; `lint.json` = 0 lá»—i (cuá»™n ngang, nÃºt xuá»‘ng dÃ²ng/bá»‹ cáº¯t, chá»¯ vÆ°á»£t dÃ²ng, tháº» cÃ¹ng nhÃ³m lá»‡ch cao).
- Chá»¥p láº¡i: `node docs/design/flow-music/shoot.cjs` (cháº¡y tá»« PowerShell; Playwright mÆ°á»£n `E:/handora-final/node_modules`).
- Token mÃ u, font, bo gÃ³c láº¥y nguyÃªn tá»« `frontend/src/theme-studio.css` (Lacquer Studio, há»“ng #f2558f); báº£n sÃ¡ng lÃ  token má»›i (Flowboard hiá»‡n chá»‰ cÃ³ tá»‘i).

### MÃ n Ä‘Ã£ dá»±ng
1. **Flow Music** (má»¥c má»›i trÃªn sidebar, sau Image Gen): khung Soáº¡n bÃ i trÃ¡i (tiÃªu Ä‘á», phong cÃ¡ch, lá»i + nÃºt chÃ¨n nhÃ£n [Verse]â€¦, cÃ´ng táº¯c KhÃ´ng lá»i, Model, Sá»‘ báº£n 1â€“4, MP3/WAV, chá»n tÃ i khoáº£n, NÃ¢ng cao: stems + seed; chÃ¢n: credit sáº½ tá»‘n / cÃ²n láº¡i + nÃºt Táº¡o) Â· pháº£i: tab HÃ ng Ä‘á»£i (lÆ°á»›i cá»™t cá»‘ Ä‘á»‹nh: bÃ i Â· tráº¡ng thÃ¡i Â· tiáº¿n Ä‘á»™ Â· tÃ i khoáº£n Â· credit Â· lÃºc Â· thao tÃ¡c; bÃ i xong má»Ÿ cÃ¡c báº£n vá»›i waveform, táº£i MP3/WAV, stems, lÃªn board; lá»—i hiá»‡n dÃ²ng Ä‘á» + nÃºt Kiá»ƒm tra) vÃ  tab ThÆ° viá»‡n (lÆ°á»›i/báº£ng, tÃ¬m, lá»c chip, chá»n nhiá»u â†’ actionbar ghim Ä‘Ã¡y) Â· player ghim Ä‘Ã¡y.
   - Mobile: 3 tab Soáº¡n bÃ i / HÃ ng Ä‘á»£i / ThÆ° viá»‡n, nav Ä‘Ã¡y.
2. **TÃ i khoáº£n** (Ä‘á»•i tÃªn tá»« "TÃ i khoáº£n Flow"): 4 KPI Â· khá»‘i **Link MCP cá»§a tÃ´i** ná»•i báº­t (copy, nÆ¡i dÃ¡n: flowytb / claude.ai / ChatGPT, táº¡o link má»›i, thu há»“i) Â· má»—i tÃ i khoáº£n Google 1 tháº» cÃ³ 2 Ã´ dá»‹ch vá»¥ Flow áº£nh + Flow Music (tráº¡ng thÃ¡i, credit, báº­n/ráº£nh, láº§n kiá»ƒm, nÃºt Kiá»ƒm tra láº¡i / Má»Ÿ flowmusic.app) Â· hÆ°á»›ng dáº«n 4 bÆ°á»›c cÃ³ hÃ¬nh Â· danh sÃ¡ch mÃ£ ghÃ©p ná»‘i + link Ä‘ang hoáº¡t Ä‘á»™ng.

### Cáº§n Owner quyáº¿t
1. **Link MCP chá»‰ hiá»‡n Ä‘á»§ 1 láº§n lÃºc táº¡o** (backend chá»‰ lÆ°u hash token `fbt_`, nhÆ° hiá»‡n táº¡i). Muá»‘n lÃºc nÃ o cÅ©ng copy Ä‘Æ°á»£c thÃ¬ pháº£i lÆ°u token dáº¡ng mÃ£ hoÃ¡ â€” kÃ©m an toÃ n hÆ¡n. Äá» xuáº¥t: giá»¯ 1 láº§n + nÃºt "Táº¡o link má»›i".
2. ThÃªm **giao diá»‡n sÃ¡ng** cho cáº£ Flowboard (hiá»‡n chá»‰ tá»‘i) hay chá»‰ giá»¯ tá»‘i?
3. Äá»•i menu "TÃ i khoáº£n Flow" â†’ "TÃ i khoáº£n" (gá»™p Flow áº£nh + Flow Music).
4. Backend cáº§n thÃªm khi code: `GET /api/music/requests?limit&cursor` (lá»‹ch sá»­/thÆ° viá»‡n), waveform peaks, tiÃªu Ä‘á» + phong cÃ¡ch lÆ°u trong káº¿t quáº£.

## BÆ°á»›c 2 Â· Code UI tháº­t â€” chÆ°a báº¯t Ä‘áº§u (chá» duyá»‡t)
## BÆ°á»›c 3 Â· Deploy â€” chá»‰ khi Owner Ä‘á»“ng Ã½

