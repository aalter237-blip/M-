// تخزين بسيط في ملف JSON — يكفي لعدد قليل جدًا من المستخدمين (شخصين أو أكثر بقليل).
// ملاحظة مهمة: على استضافة Render المجانية، القرص غير دائم بشكل مضمون عبر
// عمليات إعادة النشر (Deploy). لتخزين دائم أضف قرص Render (Persistent Disk) وحوّل
// DATA_DIR إلى مساره، أو استخدم قاعدة بيانات مُدارة لاحقًا.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILE)) {
  fs.writeFileSync(FILE, JSON.stringify({ users: {}, messages: {} }, null, 2));
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return { users: {}, messages: {} };
  }
}

let writing = false;
let pending = null;
function write(data) {
  pending = data;
  if (writing) return;
  writing = true;
  const flush = () => {
    const toWrite = pending;
    pending = null;
    fs.writeFile(FILE, JSON.stringify(toWrite, null, 2), (err) => {
      if (pending) return flush();
      writing = false;
    });
  };
  flush();
}

module.exports = { read, write };
