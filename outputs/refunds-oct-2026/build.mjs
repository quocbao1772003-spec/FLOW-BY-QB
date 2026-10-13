import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from 'file:///C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';
const dir=new URL('.',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
const src=JSON.parse(await fs.readFile(new URL('./source.json',import.meta.url),'utf8'));
const start='2026-10-01T07:00:00Z',end=src.cutoff;
const inside=t=>t&&t>=start&&t<=end;
const date=t=>t?(Date.parse(t)-7*3600000)/86400000+25569:null;
const usd=x=>Number(x?.shopMoney?.amount??0);
const clean=s=>(s??'').replace(/<[^>]*>/g,'');
const sum=(xs,fn)=>xs.reduce((a,x)=>a+fn(x),0);
const qty=(o,kind)=>sum(o.lineItems.nodes.filter(l=>kind==='gift'?/^Free Gift/.test(l.title):kind==='tip'?l.title==='Tip':!/^Free Gift/.test(l.title)&&l.title!=='Tip'),l=>l.quantity);
const caseOf=o=>{
 const refund=o.refunds.find(r=>inside(r.createdAt));
 const d=o.disputes[0];
 const won=o.events.nodes.find(e=>inside(e.createdAt)&&e.action==='dispute_won');
 const explicit=o.events.nodes.find(e=>['dispute_created','dispute_inquiry_created'].includes(e.action));
 const proxy=o.events.nodes.find(e=>e.action==='payments_adjustment'&&/will be deducted.*chargeback/.test(e.message));
 const open=explicit??proxy;
 const isNew=!!open&&inside(open.createdAt);
 const group=refund?'Hoàn tiền trong kỳ':isNew?'Tranh chấp mới':won?'Thắng trong kỳ':'Tồn đọng trước kỳ';
 const amountEvent=explicit??proxy??o.events.nodes.find(e=>/chargeback|inquiry/.test(e.message));
 const amount=amountEvent?.message.match(/\$([0-9][0-9,]*(?:\.[0-9]{2})?)/)?.[1];
 const success=refund?o.events.nodes.find(e=>e.action==='refund_success'&&inside(e.createdAt)):null;
 const prior=o.customer?.orders.nodes.filter(x=>x.createdAt<o.createdAt).length;
 const ctype=prior===undefined?'Chưa xác định':prior>0?'Cũ':'Mới';
 const action=refund?(o.name==='#HD4607-SPF'?'Đã hoàn; còn lại $1 tip':o.name==='#HD3910-SPF'?'Đối chiếu ghi chú giao chậm với tracking':'Đối chiếu tracking thất lạc'):d.status==='NEEDS_RESPONSE'?'Cần phản hồi và kiểm tra hạn bằng chứng':d.status==='UNDER_REVIEW'?'Chờ ngân hàng; theo dõi kết quả':'Theo dõi khoản hoàn về payout';
 return {o,refund,d,won,open,isNew,group,amount:amount?Number(amount.replaceAll(',','')):null,success,ctype,action};
};
const cases=src.relevant.map(caseOf).sort((a,b)=>['Hoàn tiền trong kỳ','Tranh chấp mới','Thắng trong kỳ','Tồn đọng trước kỳ'].indexOf(a.group)-['Hoàn tiền trong kỳ','Tranh chấp mới','Thắng trong kỳ','Tồn đọng trước kỳ'].indexOf(b.group));
const wb=Workbook.create();
for(const n of ['Tong quan','Vu viec','Hanh trinh','San pham','Bang chung'])wb.worksheets.add(n);
const col=n=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s};
function sheet(n,title,headers,rows,widths){
 const s=wb.worksheets.getItem(n);s.showGridLines=false;
 s.getRange('A2').values=[[title]];s.getRange('A2').format.font={name:'Arial',size:14,bold:true,color:'#26364B'};
 s.getRange('A3').values=[['Mốc ngày: America/Los_Angeles (PDT, UTC−7). Giá trị: USD. Cập nhật 12/10/2026 10:09 UTC+7.']];
 s.getRange('A3').format.font={name:'Arial',size:10,italic:true,color:'#5F6B78'};
 s.getRangeByIndexes(4,0,1,headers.length).values=[headers];
 if(rows.length)s.getRangeByIndexes(5,0,rows.length,headers.length).values=rows;
 const used=s.getRangeByIndexes(4,0,rows.length+1,headers.length);
 used.format.font={name:'Arial',size:10,color:'#243447'};used.format.rowHeight=32;used.format.verticalAlignment='center';
 const h=s.getRangeByIndexes(4,0,1,headers.length);h.format={fill:'#26364B',font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},wrapText:true,horizontalAlignment:'center',verticalAlignment:'center',rowHeight:42};
 for(let i=0;i<headers.length;i++)s.getRange(col(i)+'5:'+col(i)+(rows.length+5)).format.columnWidth=widths?.[i]??22;
 for(let i=0;i<rows.length;i++)if(i%2===1)s.getRangeByIndexes(i+5,0,1,headers.length).format.fill='#F0F4F8';
 s.freezePanes.freezeRows(5);
 if(headers.length>8)s.freezePanes.freezeColumns(1);
 s.tables.add('A5:'+col(headers.length-1)+(rows.length+5),true,'T'+n.replaceAll(' ',''));
 return s;
}
const caseRows=cases.map(c=>[c.o.name,c.group,c.refund||c.isNew?1:0,c.o.customer?.displayName??'',c.ctype,Number(c.o.customer?.numberOfOrders??0),c.d?.initiatedAs??'REFUND',c.d?.status??c.o.displayFinancialStatus,c.refund?.note??'Chưa đọc được lý do tranh chấp',usd(c.o.totalPriceSet),c.refund?usd(c.refund.totalRefundedSet):null,c.refund?null:c.amount,qty(c.o,'paid'),qty(c.o,'gift'),qty(c.o,'tip'),date(c.refund?.createdAt),date(c.success?.createdAt),date(c.open?.createdAt),c.open?.action.startsWith('dispute')?'Ngày mở trực tiếp từ event':c.open?'Mốc trừ tiền đầu tiên; chưa xác nhận ngày mở':'Không có ngày mở',date(c.won?.createdAt),c.action,'https://admin.shopify.com/store/handoranails/orders/'+c.o.id.split('/').at(-1)]);
const cs=sheet('Vu viec','Các vụ việc và tình trạng xử lý',['Đơn','Nhóm báo cáo','Thuộc nhóm mới','Khách hàng','Khách tại lúc mua','Tổng đơn hiện tại','Loại','Trạng thái','Lý do / ghi chú gốc','Giá trị đơn USD','Đã hoàn USD','Tiền trong event USD','Bộ móng mua','Quà tặng','Tip (dòng)','Tạo hoàn tiền','Hoàn thành công','Mở / mốc đầu tiên','Độ chính xác mốc mở','Ngày thắng','Việc cần làm','Nguồn đơn'],caseRows,[19,25,15,25,18,18,18,21,52,19,19,21,16,14,14,23,23,23,48,23,48,80]);
cs.getRange('I6:I20').format.wrapText=true;cs.getRange('U6:U20').format.wrapText=true;cs.getRange('I6:I20').format.rowHeight=56;
for(const c of ['J','K','L'])cs.getRange(c+'6:'+c+'20').setNumberFormat('"$"#,##0.00');
for(const c of ['P','Q','R','T'])cs.getRange(c+'6:'+c+'20').setNumberFormat('dd/mm/yyyy hh:mm');
cs.getRange('H6:H20').conditionalFormats.add('containsText',{text:'NEEDS_RESPONSE',format:{fill:'#FFF0CC',font:{bold:true,color:'#9C5B00'}}});
const jr=cases.map(c=>{
 const o=c.o,f=o.fulfillments,del=f.map(x=>x.deliveredAt).filter(Boolean).sort().at(-1);
 return [o.name,c.group,date(o.customerJourneySummary?.firstVisit?.occurredAt),o.customerJourneySummary?.firstVisit?.source??'Chưa xác định',date(o.customerJourneySummary?.lastVisit?.occurredAt),o.customerJourneySummary?.lastVisit?.source??'Chưa xác định',date(o.createdAt),date(f.map(x=>x.createdAt).sort()[0]),date(f.map(x=>x.inTransitAt).filter(Boolean).sort()[0]),date(del),'Chưa có email/chat để xác nhận',date(c.refund?.createdAt),date(c.success?.createdAt),date(c.open?.createdAt),date(c.won?.createdAt),null,null,f.map(x=>x.displayStatus).join(', ')||'Chưa fulfillment',o.customerJourneySummary?.firstVisit?.landingPage??''];
});
const js=sheet('Hanh trinh','Hành trình từng khách hàng',['Đơn','Nhóm báo cáo','Lần xem đầu','Nguồn đầu','Lần xem cuối','Nguồn cuối','Ngày mua','Tạo fulfillment','Bắt đầu vận chuyển','Ngày nhận tracking','Ngày yêu cầu qua CS','Tạo hoàn tiền','Hoàn thành công','Mở / mốc tranh chấp','Ngày thắng','Mua đến nhận (ngày)','Mua đến hoàn (ngày)','Trạng thái giao','Trang vào đầu'],jr,[19,25,23,25,23,25,23,23,23,23,36,23,23,23,23,23,23,32,100]);
for(const c of ['C','E','G','H','I','J','L','M','N','O'])js.getRange(c+'6:'+c+'20').setNumberFormat('dd/mm/yyyy hh:mm');
for(let i=6;i<=20;i++){js.getRange('P'+i).formulas=[['=IF(ISNUMBER(J'+i+'),J'+i+'-G'+i+',"n.a.")']];js.getRange('Q'+i).formulas=[['=IF(ISNUMBER(M'+i+'),M'+i+'-G'+i+',"n.a.")']];}
js.getRange('P6:Q20').setNumberFormat('0.0');
const pr=[];for(const c of cases)for(const l of c.o.lineItems.nodes){const ref=c.refund?.refundLineItems.nodes.find(r=>r.lineItem.id===l.id);pr.push([c.o.name,c.group,c.refund||c.isNew?1:0,l.title,l.sku??'Thiếu SKU trong đơn',l.variantTitle??'',/^Free Gift/.test(l.title)?'Quà tặng':l.title==='Tip'?'Tip':'Bộ móng',l.quantity,usd(l.discountedTotalSet),ref?.quantity??0,ref?usd(ref.subtotalSet):0]);}
const ps=sheet('San pham','Sản phẩm trong các đơn liên quan',['Đơn','Nhóm báo cáo','Thuộc nhóm mới','Sản phẩm','SKU','Biến thể','Phân loại','SL trong đơn','Giá dòng API USD','SL dòng được hoàn','Subtotal hoàn USD'],pr,[19,25,16,40,26,34,17,18,23,23,23]);ps.getRange('I6:I'+(pr.length+5)).setNumberFormat('"$"#,##0.00');ps.getRange('K6:K'+(pr.length+5)).setNumberFormat('"$"#,##0.00');
const er=[];for(const c of cases){
 for(const e of c.o.events.nodes.filter(e=>/dispute|refund|inquiry|chargeback/.test(e.action+' '+e.message)&&e.action!=='chargeback_risk_assessed'))er.push([c.o.name,date(e.createdAt),e.createdAt,e.action,clean(e.message),e.id,inside(e.createdAt)?'Trong kỳ':'Trước kỳ']);
 if(c.refund)er.push([c.o.name,date(c.refund.createdAt),c.refund.createdAt,'refund_note',c.refund.note??'',c.refund.id,'Trong kỳ']);
}
const es=sheet('Bang chung','Bằng chứng và diễn biến từ Shopify',['Đơn','Ngày giờ PDT','Ngày giờ UTC gốc','Action','Nội dung gốc','ID bằng chứng','Phạm vi'],er,[19,23,30,36,120,63,18]);es.getRange('B6:B'+(er.length+5)).setNumberFormat('dd/mm/yyyy hh:mm');es.getRange('C6:C'+(er.length+5)).setNumberFormat('dd/mm/yyyy hh:mm:ss" UTC"');es.getRange('E6:E'+(er.length+5)).format.wrapText=true;es.getRange('E6:E'+(er.length+5)).format.rowHeight=44;
const metrics=[
 ['Hoàn tiền được tạo trong kỳ',null,'3 đơn, 3 khách; ngày yêu cầu qua CS chưa xác định'],
 ['Tổng thực hoàn USD',null,'Chỉ cộng refund; không cộng tiền dispute'],
 ['Giá trị gốc các đơn hoàn USD',null,'Có $1 tip chưa hoàn ở HD4607'],
 ['Bộ móng trong các đơn hoàn',null,'Quà tặng và tip được đếm riêng'],
 ['Bộ móng được hoàn theo dòng',null,'8 dòng sản phẩm; không tính quà tặng'],
 ['Tranh chấp mới ghi nhận',null,'2 chargeback + 1 inquiry'],
 ['Tiền dispute mới trong event USD',null,'Có thể gồm phí hoặc khác tiền gốc; chưa tách được'],
 ['Giá trị đơn tranh chấp mới USD',null,'Đếm giá trị gốc đơn một lần'],
 ['Thắng trong kỳ',null,'2 vụ mở trước kỳ, không cộng vào tranh chấp mới'],
 ['Thua trong kỳ',0,'Không thấy event dispute_lost trong kỳ trong 18 đơn tranh chấp'],
 ['Tiền event của vụ thắng USD',null,'148.40 + 62.58; chưa xác nhận toàn bộ payout đã nhận'],
 ['Cần phản hồi hiện tại',null,'HD4324, HD4359, HD4452'],
 ['Đang xét duyệt hiện tại',null,'7 vụ; gồm tồn đọng từ tháng 9'],
 ['Tổng tranh chấp chưa kết thúc',null,'10 vụ tại thời điểm trích xuất'],
 ['Tổng đơn nhóm mới / refund',null,'3 refund + 3 dispute mới; 6 khách khác nhau'],
 ['Giá trị đơn nhóm mới USD',null,'Không cộng các đơn thắng hoặc tồn đọng trước kỳ'],
 ['Bộ móng nhóm mới',null,'14 bộ; quà tặng và tip không tính vào bộ móng'],
 ['Khách mới ở thời điểm mua (nhóm mới)',null,'Căn cứ thứ tự đơn và lịch sử đơn; không dùng số đơn hiện tại'],
 ['Khách cũ ở thời điểm mua (nhóm mới)',null,'0 trong 6 trường hợp mới được ghi nhận'],
 ['Tổng yêu cầu hoàn tiền qua mọi kênh','Chưa xác định','Chưa đọc được email/chat và PayPal'],
];
const ss=sheet('Tong quan','Handora: hoàn tiền và tranh chấp 1–12/10/2026',['Chỉ số','Giá trị','Diễn giải'],metrics,[48,25,110]);ss.freezePanes.unfreeze();ss.tabColor='#26364B';
const formulas={
6:'COUNTIFS(\'Vu viec\'!B6:B20,"Hoàn tiền trong kỳ")',7:'SUM(\'Vu viec\'!K6:K20)',
8:'SUMIFS(\'Vu viec\'!J6:J20,\'Vu viec\'!B6:B20,"Hoàn tiền trong kỳ")',
9:'SUMIFS(\'Vu viec\'!M6:M20,\'Vu viec\'!B6:B20,"Hoàn tiền trong kỳ")',
10:'SUM(\'San pham\'!J6:J'+(pr.length+5)+')',
11:'COUNTIFS(\'Vu viec\'!B6:B20,"Tranh chấp mới")',
12:'SUM(\'Vu viec\'!L9:L11)',
13:'SUMIFS(\'Vu viec\'!J6:J20,\'Vu viec\'!B6:B20,"Tranh chấp mới")',
14:'COUNTIFS(\'Vu viec\'!B6:B20,"Thắng trong kỳ")',
16:'SUM(\'Vu viec\'!L12:L13)',
17:'COUNTIFS(\'Vu viec\'!H6:H20,"NEEDS_RESPONSE")',
18:'COUNTIFS(\'Vu viec\'!H6:H20,"UNDER_REVIEW")',
19:'SUM(B17:B18)',
20:'SUM(\'Vu viec\'!C6:C20)',
21:'SUMIFS(\'Vu viec\'!J6:J20,\'Vu viec\'!C6:C20,1)',
22:'SUMIFS(\'Vu viec\'!M6:M20,\'Vu viec\'!C6:C20,1)',
23:'COUNTIFS(\'Vu viec\'!C6:C20,1,\'Vu viec\'!E6:E20,"Mới")',
24:'COUNTIFS(\'Vu viec\'!C6:C20,1,\'Vu viec\'!E6:E20,"Cũ")'
};
for(const [row,f]of Object.entries(formulas))ss.getRange('B'+row).formulas=[['='+f]];
for(const r of [7,8,12,13,16,21])ss.getRange('B'+r).setNumberFormat('"$"#,##0.00');
ss.getRange('A28:C28').values=[['Lý do hoàn','Số vụ','USD đã hoàn']];
const reasons=[['Mua nhầm',1,41.91],['Giao chậm / không cần nữa',1,77.32],['Thất lạc',1,118.85]];
ss.getRange('A29:C31').values=reasons;ss.getRange('C29:C31').setNumberFormat('"$"#,##0.00');
ss.getRange('A34').values=[['Giới hạn và các điểm cần đối chiếu']];
const notes=[
 'Nguồn: Shopify Admin kết nối Handora. Quét đủ 719 đơn cập nhật từ 01/10 00:00 PDT, 18 đơn có trạng thái tranh chấp; phân trang đã hết.',
 'Kỳ yêu cầu: 01–12/10/2026. Trích xuất lúc 12/10 10:09 UTC+7 = 11/10 20:09 PDT; ngày 12/10 chưa kết thúc và chưa bắt đầu tại cửa hàng.',
 '3 refund là các giao dịch hoàn được ghi nhận, không phải toàn bộ yêu cầu gửi qua CS. Chưa có email/chat; ngày yêu cầu, yêu cầu bị từ chối hoặc đang chờ có thể thiếu.',
 'Đọc tài khoản Shopify Payments bị từ chối quyền. Lý do dispute, số tiền gốc dispute, phí, hạn bằng chứng và ngày kết thúc chính thức chưa đầy đủ. Event + OrderDisputeSummary dùng để đối chiếu.',
 'PayPal và cổng thanh toán ngoài Shopify Payments chưa được truy cập. Không xác nhận đây là toàn bộ tranh chấp mọi kênh.',
 'HD3910: note nói hơn một tháng giao đến; tracking mua 05/09, giao 29/09 (~23.8 ngày). Giữ nguyên hai nguồn, chưa chọn nguồn nào thay cho nguồn nào.',
 'HD4607: tạo refund 01/10 21:13 PDT, thành công 02/10 21:15 PDT. Giá trị đơn 42.91, hoàn 41.91; chênh 1.00 tương ứng dòng Tip.',
 'Ngày xem là lượt ghé có attribution trong Shopify, không chứng minh toàn bộ lịch sử xem. Tạo fulfillment không đồng nghĩa ngày giao thực tế.',
 'Phân loại khách mới/cũ tại đơn đang xét từ lịch sử mua. Marie: HD3361 là đơn đầu, HD3495 là đơn sau; Lindsey có đơn thứ 2 ngày 11/10 nhưng HD4059 vẫn là đơn đầu.',
 'Dòng sản phẩm API và subtotal refund có thể dùng cơ sở giảm giá khác nhau; lấy totalPriceSet làm giá trị đơn, totalRefundedSet làm tiền hoàn. Số bộ móng loại Free Gift và Tip.',
 'Chưa tính tỷ lệ refund/doanh thu kỳ: các đơn có thể mua tháng 9, cần xác định mẫu số và cohort phù hợp. Không dùng 719 đơn cập nhật làm tỷ lệ refund.',
];
ss.getRangeByIndexes(34,0,notes.length,1).values=notes.map(n=>[n]);
ss.getRange('A35:A45').format.columnWidth=48;
ss.getRange('A35:C45').format.rowHeight=36;
for(let i=35;i<=45;i++){ss.getRange('A'+i+':C'+i).merge();ss.getRange('A'+i).format.wrapText=true;ss.getRange('A'+i).format.font={name:'Arial',size:10,color:'#455568'};}
ss.getRange('A28:C28').format={fill:'#26364B',font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},rowHeight:30};
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'Tong quan!A5:C25',include:'values,formulas',tableMaxRows:21,tableMaxCols:3,maxChars:6000})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#SPILL!',options:{useRegex:true,maxResults:20},summary:'Error scan',maxChars:1500})).ndjson);
for(const [n,r] of [['Tong quan','A2:C25'],['Vu viec','A5:H11'],['Hanh trinh','A5:J10'],['San pham','A5:H12'],['Bang chung','A5:E10']]){
 try{const p=await wb.render({sheetName:n,range:r,scale:1,format:'png'});await fs.writeFile(new URL('./preview-'+n.replaceAll(' ','-')+'.png',import.meta.url),new Uint8Array(await p.arrayBuffer()));}catch(e){console.log('Render error '+n+': '+e.message);}
}
const np=await wb.render({sheetName:'Tong quan',range:'A28:C45',scale:1,format:'png'});await fs.writeFile(new URL('./preview-notes.png',import.meta.url),new Uint8Array(await np.arrayBuffer()));
await (await SpreadsheetFile.exportXlsx(wb)).save(new URL('./Handora_Refunds_Disputes_01-12_Oct_2026.xlsx',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'));
const news=cases.filter(c=>c.refund||c.isNew);
console.log(JSON.stringify({newCases:news.length,customers:new Set(news.map(c=>c.o.customer.id)).size,orderValue:sum(news,c=>usd(c.o.totalPriceSet)),refund:sum(news,c=>c.refund?usd(c.refund.totalRefundedSet):0),nailSets:sum(news,c=>qty(c.o,'paid')),gifts:sum(news,c=>qty(c.o,'gift')),tipLines:sum(news,c=>qty(c.o,'tip')),productRows:pr.length,eventRows:er.length}));

