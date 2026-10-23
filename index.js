const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const { pool, initDB } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'MA2024admin';
const COINS_POR_VENDA = 5;
const BONUS_PRIMEIRO_ACESSO = 100;
const MINIMO_SAQUE = 200;
const DIAS_CONFIRMACAO = 7;

app.use(cors());
app.use(express.json());

// ─── MIDDLEWARE ADMIN ────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  next();
}

// ─── SAÚDE ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, msg: 'MeusAgentes IA Backend' }));

// ─── PRÉ-VENDA (chamado antes de redirecionar ao MP) ─────────────────
// Salva quem está prestes a pagar e qual afiliado indicou
app.post('/api/pre-venda', async (req, res) => {
  const { ref_nick, buyer_nick } = req.body;
  if (!ref_nick) return res.status(400).json({ erro: 'ref_nick obrigatório' });
  try {
    await pool.query(
      'INSERT INTO pre_vendas (ref_nick, buyer_nick) VALUES ($1, $2)',
      [ref_nick.toLowerCase(), buyer_nick || null]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── WEBHOOK MERCADO PAGO ─────────────────────────────────────────────
// MP envia notificação quando pagamento é aprovado
app.post('/webhook/mp', async (req, res) => {
  try {
    const body = req.body;
    // MP envia type=payment quando pagamento é aprovado
    if (body.type !== 'payment' && body.action !== 'payment.updated') {
      return res.sendStatus(200);
    }

    const paymentId = String(body.data?.id || body.id || '');
    if (!paymentId) return res.sendStatus(200);

    // Verifica se já processamos esse payment_id
    const jaProcessado = await pool.query(
      "SELECT id FROM referrals WHERE payment_id = $1", [paymentId]
    );
    if (jaProcessado.rows.length > 0) return res.sendStatus(200);

    // Busca pré-venda mais recente não usada (últimos 30 minutos)
    const agora = Math.floor(Date.now() / 1000);
    const limite = agora - 1800; // 30 min

    const preVenda = await pool.query(
      `SELECT * FROM pre_vendas
       WHERE used = 0 AND created_at > $1
       ORDER BY created_at DESC LIMIT 1`,
      [limite]
    );

    if (preVenda.rows.length === 0) {
      // Sem pré-venda encontrada — registra sem afiliado (venda direta)
      return res.sendStatus(200);
    }

    const pv = preVenda.rows[0];

    // Marca pré-venda como usada
    await pool.query('UPDATE pre_vendas SET used = 1 WHERE id = $1', [pv.id]);

    // Registra referral como pendente
    await pool.query(
      `INSERT INTO referrals (ref_nick, buyer_nick, payment_id, coins, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [pv.ref_nick, pv.buyer_nick, paymentId, COINS_POR_VENDA]
    );

    // Garante que o afiliado existe na tabela
    await pool.query(
      `INSERT INTO affiliates (nick) VALUES ($1)
       ON CONFLICT (nick) DO NOTHING`,
      [pv.ref_nick]
    );

    // Adiciona coins pendentes
    await pool.query(
      `UPDATE affiliates SET coins_pending = coins_pending + $1 WHERE nick = $2`,
      [COINS_POR_VENDA, pv.ref_nick]
    );

    console.log(`Referral registrado: ${pv.ref_nick} → +${COINS_POR_VENDA} coins pendentes`);
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook erro:', e);
    res.sendStatus(500);
  }
});

// ─── CARTEIRA DO AFILIADO ─────────────────────────────────────────────
app.get('/api/afiliado/:nick/carteira', async (req, res) => {
  const nick = req.params.nick.toLowerCase();
  try {
    // Garante que existe
    await pool.query(
      `INSERT INTO affiliates (nick) VALUES ($1) ON CONFLICT (nick) DO NOTHING`,
      [nick]
    );

    // Aplica bônus de primeiro acesso se ainda não foi dado
    const aff = await pool.query('SELECT * FROM affiliates WHERE nick = $1', [nick]);
    const a   = aff.rows[0];

    if (!a.bonus_given) {
      await pool.query(
        `UPDATE affiliates
         SET coins_confirmed = coins_confirmed + $1, bonus_given = 1
         WHERE nick = $2`,
        [BONUS_PRIMEIRO_ACESSO, nick]
      );
    }

    // Busca dados atualizados
    const dados   = await pool.query('SELECT * FROM affiliates WHERE nick = $1', [nick]);
    const d       = dados.rows[0];
    const total   = (d.coins_pending || 0) + (d.coins_confirmed || 0);

    // Histórico de vendas
    const vendas  = await pool.query(
      `SELECT id, coins, status, created_at, confirmed_at
       FROM referrals WHERE ref_nick = $1 ORDER BY created_at DESC LIMIT 20`,
      [nick]
    );

    // Saques
    const saques  = await pool.query(
      `SELECT id, coins, pix_key, status, created_at, paid_at
       FROM withdrawals WHERE nick = $1 ORDER BY created_at DESC LIMIT 10`,
      [nick]
    );

    res.json({
      nick,
      coins_pending:   d.coins_pending   || 0,
      coins_confirmed: d.coins_confirmed || 0,
      coins_paid:      d.coins_paid      || 0,
      total_disponivel: total,
      pode_sacar:      total >= MINIMO_SAQUE,
      minimo_saque:    MINIMO_SAQUE,
      bonus_dado:      d.bonus_given     || 0,
      vendas:          vendas.rows,
      saques:          saques.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── SOLICITAR SAQUE ──────────────────────────────────────────────────
app.post('/api/afiliado/:nick/solicitar-saque', async (req, res) => {
  const nick     = req.params.nick.toLowerCase();
  const { pix_key, pix_type } = req.body;

  if (!pix_key || !pix_type) {
    return res.status(400).json({ erro: 'Informe a chave Pix e o tipo.' });
  }

  try {
    const aff = await pool.query('SELECT * FROM affiliates WHERE nick = $1', [nick]);
    if (aff.rows.length === 0) return res.status(404).json({ erro: 'Afiliado não encontrado.' });

    const d     = aff.rows[0];
    const total = (d.coins_pending || 0) + (d.coins_confirmed || 0);

    if (total < MINIMO_SAQUE) {
      return res.status(400).json({
        erro: `Saldo insuficiente. Você tem ${total} MA Coins. Mínimo: ${MINIMO_SAQUE}.`
      });
    }

    // Verifica se já tem saque pendente
    const jaPendente = await pool.query(
      "SELECT id FROM withdrawals WHERE nick = $1 AND status = 'requested'",
      [nick]
    );
    if (jaPendente.rows.length > 0) {
      return res.status(400).json({ erro: 'Você já tem um saque aguardando aprovação.' });
    }

    const coinsParaSacar = total;

    // Cria solicitação de saque
    await pool.query(
      `INSERT INTO withdrawals (nick, coins, pix_key, pix_type)
       VALUES ($1, $2, $3, $4)`,
      [nick, coinsParaSacar, pix_key, pix_type]
    );

    // Zera carteira (move para paid temporariamente — só efetiva no admin)
    await pool.query(
      `UPDATE affiliates
       SET coins_pending = 0, coins_confirmed = 0
       WHERE nick = $1`,
      [nick]
    );

    res.json({
      ok: true,
      msg: `Saque de R$ ${coinsParaSacar},00 solicitado! Aguarde até 3 dias úteis.`,
      coins: coinsParaSacar
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── LINK DE AFILIADO ─────────────────────────────────────────────────
app.get('/api/afiliado/:nick/link', async (req, res) => {
  const nick = req.params.nick.toLowerCase();
  const base = process.env.SITE_URL || 'https://www.meusagentesia.com.br';
  res.json({
    link: `${base}/index.html?ref=${nick}`,
    nick
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════

// Lista saques pendentes
app.get('/api/admin/saques', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT w.*, a.coins_paid
       FROM withdrawals w
       LEFT JOIN affiliates a ON a.nick = w.nick
       ORDER BY w.created_at DESC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Marca saque como pago
app.post('/api/admin/saques/:id/pagar', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const saque = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
    if (saque.rows.length === 0) return res.status(404).json({ erro: 'Saque não encontrado' });

    const s = saque.rows[0];
    if (s.status === 'paid') return res.status(400).json({ erro: 'Já foi pago' });

    const agora = Math.floor(Date.now() / 1000);
    await pool.query(
      "UPDATE withdrawals SET status = 'paid', paid_at = $1 WHERE id = $2",
      [agora, id]
    );

    // Registra coins pagos no histórico do afiliado
    await pool.query(
      'UPDATE affiliates SET coins_paid = coins_paid + $1 WHERE nick = $2',
      [s.coins, s.nick]
    );

    res.json({ ok: true, msg: `Saque #${id} de ${s.nick} marcado como pago.` });
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Lista todos os afiliados
app.get('/api/admin/afiliados', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*,
        (SELECT COUNT(*) FROM referrals r WHERE r.ref_nick = a.nick) as total_vendas,
        (SELECT COUNT(*) FROM referrals r WHERE r.ref_nick = a.nick AND r.status='confirmed') as vendas_confirmadas
       FROM affiliates a
       ORDER BY (a.coins_pending + a.coins_confirmed) DESC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Lista referrals (para debug)
app.get('/api/admin/referrals', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM referrals ORDER BY created_at DESC LIMIT 50');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Confirma referral manualmente (admin)
app.post('/api/admin/referrals/:id/confirmar', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const ref = await pool.query('SELECT * FROM referrals WHERE id = $1', [id]);
    if (ref.rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    const r = ref.rows[0];
    if (r.status !== 'pending') return res.status(400).json({ erro: 'Não está pendente' });

    const agora = Math.floor(Date.now() / 1000);
    await pool.query(
      "UPDATE referrals SET status='confirmed', confirmed_at=$1 WHERE id=$2",
      [agora, id]
    );
    await pool.query(
      `UPDATE affiliates
       SET coins_pending = GREATEST(0, coins_pending - $1),
           coins_confirmed = coins_confirmed + $1
       WHERE nick = $2`,
      [r.coins, r.ref_nick]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─── CRON: confirma referrals após 7 dias ─────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('Cron: verificando referrals para confirmar...');
  try {
    const limite = Math.floor(Date.now() / 1000) - (DIAS_CONFIRMACAO * 86400);
    const agora  = Math.floor(Date.now() / 1000);

    const pendentes = await pool.query(
      "SELECT * FROM referrals WHERE status='pending' AND created_at < $1",
      [limite]
    );

    for (const r of pendentes.rows) {
      await pool.query(
        "UPDATE referrals SET status='confirmed', confirmed_at=$1 WHERE id=$2",
        [agora, r.id]
      );
      await pool.query(
        `UPDATE affiliates
         SET coins_pending = GREATEST(0, coins_pending - $1),
             coins_confirmed = coins_confirmed + $1
         WHERE nick = $2`,
        [r.coins, r.ref_nick]
      );
      console.log(`Confirmado: referral #${r.id} de ${r.ref_nick}`);
    }
  } catch (e) {
    console.error('Cron erro:', e);
  }
});

// ─── START ────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`MeusAgentes IA Backend rodando na porta ${PORT}`));
}).catch(e => {
  console.error('Erro ao iniciar DB:', e);
  process.exit(1);
});
