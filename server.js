// server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();
const session = require('express-session');


// 連接資料庫
const db = new sqlite3.Database('./db/database.sqlite');

// 設定
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({
  secret: 'your-secret-key', // 換成你自己的密鑰
  resave: false,
  saveUninitialized: true
}));

// 首頁（加上本月預算與超支提醒）
app.get('/', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  const today = new Date();
  const yearMonth = today.toISOString().slice(0, 7);

  db.all(`SELECT * FROM 交易明細 WHERE user_id = ? ORDER BY 交易日期 DESC`, [req.session.userId], (err1, rows) => {
    if (err1) {
      console.error(err1.message);
      return res.send("讀取失敗");
    }

    db.get(
      `SELECT SUM(金額) AS total FROM 交易明細 WHERE substr(交易日期, 1, 7) = ? AND user_id = ?`,
      [yearMonth, req.session.userId],

      (err2, totalRow) => {
        db.get(
          `SELECT 預算上限 FROM 月度預算 WHERE 年月 = ? AND user_id = ?`,
          [yearMonth],
          (err3, budgetRow) => {
            const total = totalRow?.total || 0;
            const limit = budgetRow?.預算上限 || null;
            const overBudget = limit !== null && total > limit;

            res.render('index', {
              total,
              limit,
              overBudget,
              selectedRange: null,
              transactions: rows
            });
          }
        );
      }
    );
  });
});

// 新增資料
app.post('/add', (req, res) => {
  const { date, description, amount, category, isAA, is_shared } = req.body;
  const finalCategory = category && category.trim() !== '' ? category : '未分類';
  const userId = req.session.userId;

  const amt = parseFloat(amount);
  const isAASelected = isAA === 'on';
  const isShared = is_shared === 'on' ? 1 : 0; // ✅ 將 checkbox 結果轉成 1 或 0

  if (!userId || isNaN(amt)) return res.send("使用者未登入或金額格式錯誤");

  if (isAASelected) {
    // 取得配對對象
    db.get(`SELECT partner_id FROM users WHERE id = ?`, [userId], (err, row) => {
      if (err || !row?.partner_id) {
        return res.send("❌ AA 制失敗：尚未完成雙方配對");
      }

      const partnerId = row.partner_id;
      const half = (amt / 2).toFixed(2);

      const stmt = db.prepare(`
        INSERT INTO 交易明細 (交易日期, 說明, 金額, 類別, user_id, is_shared)
        VALUES (?, ?, ?, ?, ?, 1)
      `);
      stmt.run(date, description, half, finalCategory, userId);
      stmt.run(date, description, half, finalCategory, partnerId);
      stmt.finalize(() => res.redirect('/'));
    });
  } else {
    db.run(
      `INSERT INTO 交易明細 (交易日期, 說明, 金額, 類別, user_id, is_shared)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [date, description, amt, finalCategory, userId, isShared],
      err => {
        if (err) {
          console.error('❌ 寫入失敗:', err.message);
          return res.send("寫入失敗");
        }
        res.redirect('/');
      }
    );
  }
});

// 交易清單頁面
app.get('/list', (req, res) => {
  const updated = req.query.updated;

  db.all(`SELECT * FROM 交易明細 WHERE user_id = ? ORDER BY 交易日期 DESC`, [req.session.userId], (err, rows) => {
    if (err) {
      console.error("❌ 載入清單失敗:", err.message);
      return res.send("讀取失敗");
    }

    db.all(`SELECT DISTINCT 類別 FROM 交易明細`, [], (err2, cats) => {
      if (err2) {
        console.error("❌ 載入類別失敗:", err2.message);
        return res.send("類別讀取失敗");
      }

      // ✅ 將 null、空字串轉為 "未分類"，並移除重複
      const categories = Array.from(
        new Set(
          cats.map(c => c.類別?.trim() || '未分類')
        )
      );

      res.render('list', {
        transactions: rows,
        categories,
        updated
      });
    });
  });
});

// 顯示預算頁面
app.get('/budget', (req, res) => {
  const userId = req.session.userId;
  const yearMonth = req.query.month || new Date().toISOString().slice(0, 7);  // ✅ 支援 URL 指定月份

  db.get(
    `SELECT SUM(金額) AS total FROM 交易明細 WHERE substr(交易日期, 1, 7) = ? AND user_id = ?`,
    [yearMonth, userId],
    (err1, totalRow) => {
      if (err1) {
        console.error('❌ 查詢總花費失敗:', err1.message);
        return res.send("查詢失敗");
      }

      db.get(
        `SELECT 預算上限 FROM 月度預算 WHERE 年月 = ? AND user_id = ?`,
        [yearMonth, userId],
        (err2, budgetRow) => {
          if (err2) {
            console.error('❌ 查詢預算失敗:', err2.message);
            return res.send("查詢失敗");
          }

          const total = totalRow?.total || 0;
          const limit = budgetRow?.預算上限 ?? null;
          const overBudget = limit !== null && total > limit;

          res.render('budget', {
            total,
            limit,
            overBudget
          });
        }
      );
    }
  );
});

// 儲存月度預算（對應 POST /budget）
app.post('/budget', (req, res) => {
  const { month, limit } = req.body;
  const userId = req.session.userId;

  if (!month || !limit || !userId) {
    return res.send("請填寫完整資料");
  }

  const [y, m] = month.split('-');
  const formattedMonth = `${y}-${m.padStart(2, '0')}`;  // 補零

  db.run(
    `INSERT INTO 月度預算 (年月, 預算上限, user_id)
     VALUES (?, ?, ?)
     ON CONFLICT(年月, user_id) DO UPDATE SET 預算上限 = excluded.預算上限`,
    [formattedMonth, limit, userId],
    (err) => {
      if (err) {
        console.error("❌ 儲存預算失敗:", err.message);
        return res.send("儲存預算失敗");
      }
      res.redirect(`/budget?month=${month}`);

    }
  );
});

// 查詢資料
app.post('/query', (req, res) => {
  const { range, start, end } = req.body;
  const userId = req.session.userId;

  let query = `SELECT * FROM 交易明細 `;
  let totalQuery = `SELECT SUM(金額) AS total FROM 交易明細 `;
  const params = [];
  let yearMonth = new Date().toISOString().slice(0, 7);

  if (range === 'custom' && start && end) {
    query += `WHERE 交易日期 BETWEEN ? AND ? AND user_id = ? ORDER BY 交易日期 DESC`;
    totalQuery += `WHERE 交易日期 BETWEEN ? AND ? AND user_id = ?`;
    params.push(start, end, userId);
    yearMonth = start.slice(0, 7);
  } else {
    const offset = range === 'year' ? '-1 year' : range === 'month' ? '-1 month' : '-7 days';
    query += `WHERE 交易日期 >= date('now', ?) AND user_id = ? ORDER BY 交易日期 DESC`;
    totalQuery += `WHERE 交易日期 >= date('now', ?) AND user_id = ?`;
    params.push(offset, userId);
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('❌ 查詢明細失敗:', err.message);
      return res.send("查詢失敗");
    }

    db.get(totalQuery, params, (err2, row) => {
      if (err2) {
        console.error('❌ 查詢總金額失敗:', err2.message);
        return res.send("查詢失敗");
      }

      db.get(`SELECT 預算上限 FROM 月度預算 WHERE 年月 = ? AND user_id = ?`, [yearMonth], (err3, budgetRow) => {
        if (err3) {
          console.error("❌ 查詢預算失敗:", err3.message);
          return res.send("查詢失敗");
        }

        const limit = budgetRow ? budgetRow.預算上限 : null;
        const overBudget = limit !== null && row.total > limit;

        res.render('index', {
          total: row.total || 0,
          transactions: rows,
          selectedRange: range,
          limit,
          overBudget
        });
      });
    });
  });
});

// 編輯資料(類別)
app.post('/update-category/:id', (req, res) => {
  const id = req.params.id;
  const category = req.body.customCategory?.trim() || req.body.category;




  db.run(`UPDATE 交易明細 SET 類別 = ? WHERE 編號 = ?`, [category, id], (err) => {
    if (err) {
      console.error("❌ 更新類別失敗:", err.message);
      return res.send("更新失敗");
    }
    res.redirect('/list?updated=1');

  });
});

//分析資料
app.get('/analysis', (req, res) => {
  const userId = req.session.userId;
  const { start, end } = req.query;

  let query = `
    SELECT 
      COALESCE(NULLIF(TRIM(類別), ''), '未分類') AS 類別,
      SUM(金額) AS total 
    FROM 交易明細
    WHERE user_id = ?
  `;
  const params = [userId];

  if (start && end) {
    query += ` AND 交易日期 BETWEEN ? AND ?`;
    params.push(start, end);
  }

  query += ` GROUP BY COALESCE(NULLIF(TRIM(類別), ''), '未分類')`;

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("❌ 查詢分類統計失敗:", err.message);
      return res.send("查詢失敗");
    }
    const labels = rows.map(r => r.類別 || '未分類');
    const data = rows.map(r => r.total);
    res.render('analysis', {
      labels,
      data,
      start,
      end,
      from: 'self'
    });

  });
});

// 雙人共用分析頁面
app.get('/partner-analysis', (req, res) => {
  const userId = req.session.userId;

  if (!userId) return res.redirect('/login');

  db.get(`SELECT partner_id FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err || !row || !row.partner_id) {
      return res.send("尚未配對，無法查看分析");
    }

    const partnerId = row.partner_id;

    db.all(`
      SELECT 
        COALESCE(NULLIF(TRIM(類別), ''), '未分類') AS 類別,
        SUM(金額) AS total
      FROM 交易明細
      WHERE is_shared = 1 AND user_id IN (?, ?)
      GROUP BY COALESCE(NULLIF(TRIM(類別), ''), '未分類')
    `, [userId, partnerId], (err2, rows) => {
      if (err2) {
        console.error("❌ 查詢共同分析失敗:", err2.message);
        return res.send("查詢失敗");
      }

      const labels = rows.map(r => r.類別);
      const data = rows.map(r => r.total);

      res.render('analysis', {
        labels,
        data,
        start: null,
        end: null,
        from: 'partner'
      });
    });
  });
});

//顯示圓餅圖清單
app.get('/category/:name', (req, res) => {
  const rawCategory = req.params.name;
  const category = rawCategory === '未分類' ? '未分類' : rawCategory;
  const { start, end, from } = req.query;
  const userId = req.session.userId;

  if (!userId) return res.redirect('/login');

  let query = `SELECT * FROM 交易明細 WHERE IFNULL(類別, '未分類') = ?`;
  const params = [category];

  if (from === 'partner') {
    // 雙人圖表 → 僅共用交易
    db.get(`SELECT partner_id FROM users WHERE id = ?`, [userId], (err, row) => {
      if (err || !row || !row.partner_id) {
        return res.send("無法查詢配對資料");
      }

      const partnerId = row.partner_id;
      query += ` AND is_shared = 1 AND user_id IN (?, ?)`;
      params.push(userId, partnerId);

      if (start && end) {
        query += ` AND 交易日期 BETWEEN ? AND ?`;
        params.push(start, end);
      }

      query += ` ORDER BY 交易日期 DESC`;

      db.all(query, params, (err2, rows) => {
        if (err2) {
          console.error("❌ 類別明細查詢失敗:", err2.message);
          return res.send("查詢失敗");
        }

        res.render('category-list', {
          category,
          transactions: rows,
          start,
          end,
          from
        });
      });
    });

  } else {
    // 個人圖表
    query += ` AND user_id = ?`;
    params.push(userId);

    if (start && end) {
      query += ` AND 交易日期 BETWEEN ? AND ?`;
      params.push(start, end);
    }

    query += ` ORDER BY 交易日期 DESC`;

    db.all(query, params, (err, rows) => {
      if (err) {
        console.error("❌ 類別明細查詢失敗:", err.message);
        return res.send("查詢失敗");
      }

      res.render('category-list', {
        category,
        transactions: rows,
        start,
        end,
        from
      });
    });
  }
});

// 刪除所有資料
app.post('/delete-all', (req, res) => {
  db.run(`DELETE FROM 交易明細`, [], (err) => {
    if (err) {
      console.error('❌ 全部刪除失敗:', err.message);
      return res.send("全部刪除失敗");
    }
    console.log('🧹 已刪除所有交易資料');
    res.redirect('/');
  });
});

const bcrypt = require('bcrypt');

// 顯示註冊頁面
app.get('/register', (req, res) => {
  res.render('register');
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users (username, password) VALUES (?, ?)`,
    [username, hashedPassword],
    function (err) { // 用 function 才能使用 this.lastID
      if (err) {
        console.error("❌ 註冊失敗：", err.message);
        return res.send("註冊失敗（可能帳號已存在）");
      }

      req.session.userId = this.lastID; // ✅ 自動登入
      res.redirect('/'); // ✅ 直接進入首頁
    }
  );
});

// 啟用 session
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true
}));

// 顯示登入頁面
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// 處理登入請求
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err) {
      console.error("❌ 查詢用戶失敗：", err.message);
      return res.send("登入失敗");
    }

    if (!user) {
      return res.send("帳號不存在");
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.send("密碼錯誤");
    }

    // ✅ 登入成功，設定 session
    req.session.userId = user.id;
    req.session.username = user.username;

    res.redirect('/');
  });
});

// 登出功能
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("❌ 登出失敗:", err.message);
      return res.send("登出失敗");
    }
    res.redirect('/login');
  });
});

// 夥伴頁面
app.get('/partner', (req, res) => {
  const userId = req.session.userId;

  if (!userId) {
    return res.redirect('/login');
  }

  db.get(`SELECT partner_id FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err) {
      console.error("❌ 查詢配對失敗：", err.message);
      return res.send("載入失敗");
    }

    const partnerId = row?.partner_id || null;

    // 檢查對方是否也填自己當 partner_id（雙方互相）
    if (partnerId) {
      db.get(`SELECT partner_id FROM users WHERE id = ?`, [partnerId], (err2, partnerRow) => {
        if (err2) {
          console.error("❌ 檢查雙方配對失敗：", err2.message);
          return res.send("載入失敗");
        }

        const isMutual = partnerRow?.partner_id === userId;

        res.render('partner', {
          userId,
          partnerId,
          isMutual,
          message: null
        });
      });
    } else {
      res.render('partner', {
        userId,
        partnerId: null,
        isMutual: false, // ✅ 補上這行
        message: null
      });
    }
  });
});

// 處理夥伴邀請
app.post('/partner', (req, res) => {
  const userId = req.session.userId;
  const partnerId = parseInt(req.body.partnerId);

  if (!userId || isNaN(partnerId) || userId === partnerId) {
    return res.render('partner', {
      userId,
      partnerId: null,
      isMutual: false,
      message: "請輸入有效的對方 ID，且不得與自己相同。"
    });
  }

  // 檢查對方是否存在
  db.get(`SELECT id, partner_id FROM users WHERE id = ?`, [partnerId], (err, row) => {
    if (err) {
      console.error("❌ 查詢用戶失敗：", err.message);
      return res.send("配對失敗");
    }

    if (!row) {
      return res.render('partner', {
        userId,
        partnerId: null,
        isMutual: false,
        message: "找不到該用戶 ID。"
      });
    }

    // 自己寫入對方 ID（單向配對）
    db.run(`UPDATE users SET partner_id = ? WHERE id = ?`, [partnerId, userId], (err2) => {
      if (err2) {
        console.error("❌ 更新配對失敗：", err2.message);
        return res.send("配對失敗");
      }

      const isMutual = row.partner_id === userId;
      res.render('partner', {
        userId,
        partnerId,
        isMutual,
        message: isMutual ? "✅ 配對成功！" : "⏳ 已送出配對邀請，等待對方也輸入你的 ID..."
      });
    });
  });
});

//取消配對
app.post('/unpair', (req, res) => {
  const userId = req.session.userId;

  if (!userId) return res.redirect('/login');

  // 先取得對方 partner_id
  db.get(`SELECT partner_id FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err || !row?.partner_id) {
      return res.redirect('/partner'); // 沒配對或錯誤
    }

    const partnerId = row.partner_id;

    db.serialize(() => {
      // 清除雙方的 partner_id
      db.run(`UPDATE users SET partner_id = NULL WHERE id = ?`, [userId]);
      db.run(`UPDATE users SET partner_id = NULL WHERE id = ?`, [partnerId], (err2) => {
        if (err2) {
          console.error("❌ 取消配對失敗：", err2.message);
          return res.send("取消配對失敗");
        }

        res.redirect('/partner');
      });
    });
  });
});

// 編輯aa制交易資料
app.post('/add-aa', (req, res) => {
  const userId = req.session.userId;
  const { date, description, amount, category, is_shared } = req.body;
  const isShared = is_shared === '1' ? 1 : 0;


  if (!userId) return res.redirect('/login');

  db.get(`SELECT partner_id FROM users WHERE id = ?`, [userId], (err, row) => {
    if (err || !row || !row.partner_id) {
      console.error("❌ 查詢配對失敗：", err?.message);
      return res.send("目前尚未配對，請先完成配對！");
    }

    const partnerId = row.partner_id;
    const half = Math.round(Number(amount) / 2); // 平分並四捨五入

    db.serialize(() => {
  db.run(
    `INSERT INTO 交易明細 (交易日期, 說明, 金額, 類別, user_id, is_shared) VALUES (?, ?, ?, ?, ?, ?)`,
    [date, description, half, category, userId, 1]
  );

  db.run(
    `INSERT INTO 交易明細 (交易日期, 說明, 金額, 類別, user_id, is_shared) VALUES (?, ?, ?, ?, ?, ?)`,
    [date, description, amount - half, category, partnerId, 1],
    err2 => {
      if (err2) {
        console.error("❌ 寫入交易失敗：", err2.message);
        return res.send("交易記錄失敗");
      }
      res.render('partner', {
        userId,
        partnerId,
        isMutual: true,
        message: "✅ 新增成功！"
      });
    }
  );
});
    });

  });

// 共同分析頁面
app.get('/category/:name', (req, res) => {
  const rawCategory = req.params.name;
  const category = rawCategory === '未分類' ? '未分類' : rawCategory;
  const { start, end, from } = req.query;  // ✅ 把 from 加進來
  const userId = req.session.userId;

  if (!userId) return res.redirect('/login');

  let query = `SELECT * FROM 交易明細 WHERE IFNULL(類別, '未分類') = ? AND user_id = ?`;
  const params = [category, userId];

  if (start && end) {
    query += ` AND 交易日期 BETWEEN ? AND ?`;
    params.push(start, end);
  }

  query += ` ORDER BY 交易日期 DESC`;

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("❌ 類別明細查詢失敗:", err.message);
      return res.send("查詢失敗");
    }

    res.render('category-list', {
      category,
      transactions: rows,
      start,
      end,
      from  // ✅ 傳入 EJS
    });
  });
});







// 啟動伺服器
app.listen(3000, () => {
  console.log('🚀 伺服器已啟動：http://localhost:3000');
});
// 刪除特定交易
app.post('/delete/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM 交易明細 WHERE 編號 = ?`, [id], (err) => {
    if (err) {
      console.error("❌ 刪除失敗:", err.message);
      return res.send("刪除失敗");
    }
    console.log(`🗑️ 已刪除編號 ${id} 的交易`);
    res.redirect('/');
  });
});



