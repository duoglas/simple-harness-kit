const express = require('express');
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/api/orders', (req, res) => res.status(201).json({ id: 1 }));
app.listen(process.env.PORT || 3000);
