# بوت مستر

بوت Messenger يعتمد على `ws3-fca` وملف `appstate.json`. تم تسجيله كحزمة
مستقلة داخل workspace حتى يكون تشغيله وإدارته واضحين مع لوحة التحكم وواجهة API.

## التشغيل

من مجلد المشروع:

```bash
pnpm --filter @workspace/mister-bot run start
```

أو باستخدام السكربتات المختصرة:

```bash
pnpm run bot:start
pnpm run bot:check
```

## ملفات التشغيل

- `appstate.json`: جلسة Facebook الحالية، ولا يجب رفعها إلى Git.
- `admins-config.json`: قائمة معرفات المشرفين، ولا يجب رفعها إلى Git.
- `commands-config.json`: تفعيل وتعطيل الأوامر.
- `bot-state.json`: حالة التشغيل التي تقرؤها لوحة التحكم.
- `Commands/`: الأوامر التي يتم تحميلها تلقائيًا عند تسجيل الدخول.

إذا لم يكن `admins-config.json` موجودًا، لن يحصل أي مستخدم على صلاحيات
إدارية تلقائيًا. استخدم `admins-config.example.json` كنقطة بداية.

## ملاحظات

- يعتمد البوت على جلسة `appstate` الحالية وليس على Meta Graph API.
- يمكن تغيير مسار `yt-dlp` عبر المتغير الاختياري `YTDL_PATH`.