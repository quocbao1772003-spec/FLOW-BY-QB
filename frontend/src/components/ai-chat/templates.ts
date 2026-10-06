// Ready-made requests for the AI panel. Each one is detailed enough that a
// single "Use" click (image attached + sent) gets a Handora-ready answer.

export interface ChatTemplate {
  id: "name" | "prompt" | "improve";
  title: string;
  hint: string;
  /** Needs at least one selected node to make sense. */
  needsNode: boolean;
  /**
   * Full request text. `fill` = the user will edit it first (blanks left
   * open, cursor parked on the first one); otherwise blanks say "infer it".
   */
  text(fill: boolean): string;
  /** Where to park the cursor when filling (text right after this marker). */
  cursorAfter?: string;
}

export const TEMPLATES: ChatTemplate[] = [
  {
    id: "name",
    title: "Đặt tên sản phẩm",
    hint: "Phân tích ảnh, gợi ý tên chuẩn vibe Handora + tag SEO",
    needsNode: true,
    cursorAfter: "- Collection: ",
    text: (fill) => `Đặt tên sản phẩm cho bộ press-on nails trong ảnh đính kèm, đúng phong cách tên của Handora Nails.

Thông tin:
- Collection: ${fill ? "" : "(chưa ghi — tự đoán từ ảnh)"}
- Ghi chú / cảm hứng thêm: ${fill ? "" : "(không có)"}
- Tên đã dùng trong collection, cần tránh: ${fill ? "" : "(không có)"}

Cách làm:
1. Phân tích ảnh trước: dáng và độ dài móng, 2–3 màu chủ đạo, họa tiết và charm 3D nổi bật trên từng móng, hiệu ứng bề mặt (chrome, cat eye, glitter, french tip, thạch…), cảm xúc chung (cute, sang trọng, cozy, goth, quyến rũ…).
2. Đặt tên theo phong cách Handora: đúng 2 từ tiếng Anh, Title Case, gợi hình và dễ nhớ — kiểu [màu/chất liệu/cảm xúc] + [họa tiết] (Golden Ribbon, Pearl Berry, Frost Plaid), [họa tiết] + [khoảnh khắc/bối cảnh] (Puppy Stocking, Gingerbread Lane, Fruit Picnic) hoặc chơi chữ dễ thương (Beary Picnic, Ho Ho Pink, Tinsel Kiss). Không dùng chữ "nails"/"press-on", không dùng tên thương hiệu hay nhân vật có bản quyền.

Trả lời theo thứ tự:
- Phân tích ảnh: 3–4 gạch đầu dòng ngắn
- 3 tên đề xuất tốt nhất, mỗi tên kèm 1 câu lý do bám vào chi tiết trong ảnh
- 5 tên dự phòng
- Tên nên chọn nhất và dạng slug cho tên file (vd: golden-ribbon)
- 6–8 tag Shopify kiểu Handora (vd: christmas nails, bow nails, almond nails, 3d nail art)`,
  },
  {
    id: "prompt",
    title: "Viết prompt ảnh sản phẩm",
    hint: "Từ ảnh bộ nail thành prompt đầy đủ cho GemPix 2",
    needsNode: true,
    cursorAfter: "- Mục tiêu ảnh: ",
    text: (fill) => `Viết prompt tạo ảnh sản phẩm cho Google Flow (GemPix 2 / Nano Banana Pro) dựa trên bộ press-on nails trong ảnh đính kèm.

Thông tin:
- Mục tiêu ảnh: ${fill ? "" : "(chưa ghi — đề xuất ảnh sản phẩm bán hàng phù hợp nhất với bộ móng)"}
- Bối cảnh / mùa / tông màu mong muốn: ${fill ? "" : "(tự chọn hợp với bộ móng)"}

Yêu cầu:
1. Mô tả chính xác bộ móng như trong ảnh: dáng, độ dài, màu, họa tiết từng móng, charm 3D, hiệu ứng bề mặt — không thêm chi tiết không có trong ảnh.
2. Mô tả bối cảnh, đạo cụ, ánh sáng, góc máy, ống kính; chất ảnh thật như chụp studio, sắc nét.
3. Ghi rõ phần phải giữ nguyên (sản phẩm, hộp, chữ "Handora Nails" nếu có trong ảnh).
4. Trả về 1 prompt hoàn chỉnh trong một khối \`\`\`, rồi 2 biến thể ngắn (đổi bối cảnh) bên dưới.`,
  },
  {
    id: "improve",
    title: "Cải thiện prompt của node",
    hint: "Viết lại prompt node đang chọn cho rõ và ổn định hơn",
    needsNode: true,
    cursorAfter: "- Muốn chỉnh thêm: ",
    text: (fill) => `Cải thiện prompt hiện tại của node đính kèm để ra ảnh đẹp và ổn định hơn trên GemPix 2.

- Muốn chỉnh thêm: ${fill ? "" : "(không có — chỉ làm rõ và chi tiết hơn)"}

Yêu cầu:
1. Giữ nguyên ý chính và giữ nguyên mọi tham chiếu dạng @tên-ảnh #mã trong prompt.
2. Tách rõ phần GIỮ NGUYÊN và phần THAY ĐỔI; mô tả bộ móng cụ thể theo ảnh; thêm ánh sáng, góc máy, chất ảnh thật.
3. Chỉ ra 1–2 điểm trong prompt cũ dễ làm ảnh ra sai.
4. Trả về prompt mới hoàn chỉnh trong một khối \`\`\`.`,
  },
];
