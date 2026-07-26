/**
 * HiLib Web 服务器
 *
 * Express + 静态前端，端口 8080。
 * 后端通过 src/sprr/ 下的逆向代码直接调用抖音 IM API。
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import contactsRoutes from './routes/contacts.js';
import messagesRoutes from './routes/messages.js';
import imagesRoutes from './routes/images.js';
import emojiRoutes from './routes/emoji.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 8080;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// 静态前端
app.use(express.static(path.join(__dirname, '..', 'public')));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/emoji', emojiRoutes);

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// 兜底：其他路径返回 index.html（SPA）
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  HiLib 抖音聊天适配`);
  console.log(`  ─────────────────────────────`);
  console.log(`  服务地址:  http://localhost:${PORT}`);
  console.log(`  前端目录:  ${path.join(__dirname, '..', 'public')}`);
  console.log(`  数据目录:  ${path.join(__dirname, '..', 'data')}`);
  console.log(`  ─────────────────────────────\n`);
});
