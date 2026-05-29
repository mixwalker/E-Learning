# 🎓 ClassFlow — Educational Platform

เว็บแอปสำหรับจัดการสื่อการสอนและบอร์ดการบ้านแบบ Kanban (คล้าย Jira)

---

## 📁 โครงสร้างไฟล์

```
classflow/
├── server.js          ← Express HTTPS server (port 8443)
├── public/
│   └── index.html     ← Frontend แอปหลัก
├── start.sh           ← Script รัน server อัตโนมัติ
├── package.json
└── README.md
```

---

## 🚀 วิธีรัน

### วิธีที่ 1 — ใช้ script อัตโนมัติ (แนะนำ)

```bash
chmod +x start.sh
./start.sh
```

สคริปต์จะทำทุกอย่างเอง:
1. ติดตั้ง npm packages
2. สร้าง SSL certificate สำหรับ localhost
3. เปิด HTTPS server ที่ `http://localhost:3000`

---

### วิธีที่ 2 — รันแยก (manual)

#### ขั้นตอนที่ 1: ติดตั้ง dependencies

```bash
npm install
```

#### ขั้นตอนที่ 2: รัน server

```bash
node server.js
```

เปิด browser ไปที่ → **http://localhost:3000**


## 🔌 API Endpoints

| Method | Path | คำอธิบาย |
|--------|------|----------|
| GET | `/api/tasks` | ดึงการบ้านทั้งหมด |
| POST | `/api/tasks` | สร้างการบ้านใหม่ |
| PATCH | `/api/tasks/:id` | แก้ไข/ย้าย status |
| DELETE | `/api/tasks/:id` | ลบการบ้าน |

### ตัวอย่าง POST

```bash
curl -k -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"แบบทดสอบบทที่ 6","type":"quiz","dueDate":"10 มิ.ย.","points":30}'
```

### Status ของการบ้าน

| status | ความหมาย |
|--------|----------|
| `assigned` | มอบหมายแล้ว |
| `in_progress` | กำลังทำ |
| `review` | รอตรวจ |
| `done` | ตรวจแล้ว |

---

## 🌐 การใช้งานพื้นฐาน

- **เพิ่มงาน** — คลิก "เพิ่มงาน" หรือกด `Ctrl+N`
- **กรองงาน** — คลิก chip ด้านบนบอร์ด
- **เปลี่ยนห้อง** — คลิกแท็บ ม.5/1, ม.5/2, ม.5/3
- **ปิด** — กด `Ctrl+C` ใน terminal

---

## 📦 Dependencies

```json
{
  "express": "^4.x"
}
```

Node.js 18+ recommended
