import {
  Client, GatewayIntentBits, EmbedBuilder, Colors,
  PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import express from "express";
import cors from "cors";
import session from "express-session";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

// ─── DB ────────────────────────────────────────────────────────────────────────
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS vinculaciones (
      nick_minecraft TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sanciones (
      id SERIAL PRIMARY KEY,
      nick_minecraft TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      tipo TEXT NOT NULL,
      motivo TEXT NOT NULL,
      duracion TEXT,
      staff_id TEXT NOT NULL,
      staff_username TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      dm_enviado BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS staff_sessions (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      avatar TEXT,
      access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Base de datos inicializada");
}

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const ROLES_PERMITIDOS = [];
const CANAL_LOGS_ID = null;
const DISCORD_CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PANEL_URL = process.env.PANEL_URL || "http://localhost:3000";
const API_URL = process.env.API_URL || "http://localhost:4000";
const REDIRECT_URI = `${API_URL}/auth/callback`;

// ─── EXPRESS API ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: PANEL_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "aventuraguard-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "No autenticado" });
  next();
}

// ── Auth routes ────────────────────────────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${PANEL_URL}/login?error=no_code`);
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    // Verificar que sea staff del servidor
    const guild = client.guilds.cache.first();
    let isStaff = false;
    if (guild) {
      try {
        const member = await guild.members.fetch(userData.id);
        isStaff = tienePermiso(member);
      } catch { isStaff = false; }
    }
    if (!isStaff) return res.redirect(`${PANEL_URL}/login?error=no_permission`);
    req.session.user = {
      id: userData.id,
      username: userData.username,
      avatar: userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
    };
    res.redirect(`${PANEL_URL}/dashboard`);
  } catch (err) {
    console.error("Auth error:", err);
    res.redirect(`${PANEL_URL}/login?error=auth_failed`);
  }
});

app.get("/auth/me", requireAuth, (req, res) => res.json(req.session.user));
app.post("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── Sanciones routes ───────────────────────────────────────────────────────────
app.get("/api/sanciones", requireAuth, async (req, res) => {
  const { nick, motivo, tipo, page = 1 } = req.query;
  const limit = 20; const offset = (page - 1) * limit;
  let where = []; let params = [];
  if (nick) { params.push(`%${nick.toLowerCase()}%`); where.push(`nick_minecraft ILIKE $${params.length}`); }
  if (motivo) { params.push(`%${motivo}%`); where.push(`motivo ILIKE $${params.length}`); }
  if (tipo) { params.push(tipo); where.push(`tipo = $${params.length}`); }
  const whereStr = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM sanciones ${whereStr} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    db.query(`SELECT COUNT(*) FROM sanciones ${whereStr}`, params),
  ]);
  res.json({ sanciones: rows.rows, total: parseInt(count.rows[0].count), page: parseInt(page), limit });
});

app.get("/api/sanciones/:id", requireAuth, async (req, res) => {
  const r = await db.query("SELECT * FROM sanciones WHERE id = $1", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "No encontrado" });
  res.json(r.rows[0]);
});

app.post("/api/sanciones", requireAuth, async (req, res) => {
  const { nick_minecraft, motivo, tipo, duracion } = req.body;
  const staff = req.session.user;
  const vinc = await db.query("SELECT * FROM vinculaciones WHERE nick_minecraft = $1", [nick_minecraft.toLowerCase()]);
  let userId = "manual", username = "Manual";
  if (vinc.rows.length) { userId = vinc.rows[0].user_id; username = vinc.rows[0].username; }
  const guild = client.guilds.cache.first();
  let dmEnviado = false;
  if (vinc.rows.length && guild) {
    try {
      const user = await client.users.fetch(userId);
      const sancion = TIPOS_SANCION[tipo];
      await user.send({ embeds: [new EmbedBuilder()
        .setTitle(`${sancion.emoji} Has recibido una sanción`)
        .setColor(sancion.color)
        .setDescription(`Hola **${nick_minecraft}**, el equipo de staff te informa que has recibido la siguiente sanción:`)
        .addFields(
          { name: "📋 Tipo", value: sancion.label, inline: true },
          { name: "📅 Fecha", value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true },
          ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
          { name: "📝 Motivo", value: motivo, inline: false },
          { name: "👮 Staff", value: staff.username, inline: false },
        ).setTimestamp()] });
      dmEnviado = true;
    } catch {}
  }
  const r = await db.query(
    `INSERT INTO sanciones (nick_minecraft, user_id, username, tipo, motivo, duracion, staff_id, staff_username, guild_id, dm_enviado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [nick_minecraft.toLowerCase(), userId, username, tipo, motivo, duracion||null, staff.id, staff.username, guild?.id||"web", dmEnviado]
  );
  res.json(r.rows[0]);
});

app.put("/api/sanciones/:id", requireAuth, async (req, res) => {
  const { motivo, tipo, duracion } = req.body;
  const r = await db.query(
    "UPDATE sanciones SET motivo=$1, tipo=$2, duracion=$3 WHERE id=$4 RETURNING *",
    [motivo, tipo, duracion||null, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: "No encontrado" });
  res.json(r.rows[0]);
});

app.delete("/api/sanciones/:id", requireAuth, async (req, res) => {
  await db.query("DELETE FROM sanciones WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ── Vinculaciones routes ───────────────────────────────────────────────────────
app.get("/api/vinculaciones", requireAuth, async (req, res) => {
  const r = await db.query("SELECT * FROM vinculaciones ORDER BY created_at DESC");
  res.json(r.rows);
});

app.delete("/api/vinculaciones/:nick", requireAuth, async (req, res) => {
  await db.query("DELETE FROM vinculaciones WHERE nick_minecraft = $1", [req.params.nick]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ API corriendo en puerto ${PORT}`));

// ─── BOT CONFIG ────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("vincular").setDescription("Vincula tu cuenta de Minecraft con tu Discord")
    .addStringOption(o => o.setName("nick").setDescription("Tu nick exacto en Minecraft").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("desvincular").setDescription("Desvincula tu cuenta de Minecraft").toJSON(),
  new SlashCommandBuilder().setName("vinculaciones").setDescription("Muestra todas las vinculaciones (solo staff)").toJSON(),
  new SlashCommandBuilder().setName("notificar").setDescription("Notifica a un jugador que ha recibido una sanción")
    .addStringOption(o => o.setName("nick_minecraft").setDescription("Nick del jugador en Minecraft").setRequired(true))
    .addStringOption(o => o.setName("motivo").setDescription("Motivo de la sanción").setRequired(true))
    .addStringOption(o => o.setName("tipo").setDescription("Tipo de sanción").setRequired(true)
      .addChoices(
        { name: "⚠️ Advertencia", value: "advertencia" },
        { name: "🔇 Silenciado (Mute)", value: "mute" },
        { name: "🦶 Expulsión (Kick)", value: "kick" },
        { name: "🔨 Baneo Temporal", value: "ban_temp" },
        { name: "⛔ Baneo Permanente", value: "ban_perm" },
        { name: "🔒 Jail", value: "jail" }
      ))
    .addStringOption(o => o.setName("duracion").setDescription("Duración (ej: 7 días)").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("listasanciones").setDescription("Ver historial de sanciones de un jugador (solo staff)")
    .addStringOption(o => o.setName("nick_minecraft").setDescription("Nick del jugador").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("todaslassanciones").setDescription("Ver todas las sanciones del servidor (solo staff)").toJSON(),
  new SlashCommandBuilder().setName("web").setDescription("Abre el panel de administración web").toJSON(),
];

async function registrarComandos() {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("✅ Comandos slash registrados");
  } catch (e) { console.error("❌ Error comandos:", e); }
}

const TIPOS_SANCION = {
  advertencia: { label: "⚠️ Advertencia",      color: 0xf59e0b, emoji: "⚠️" },
  mute:        { label: "🔇 Silenciado (Mute)", color: 0x6366f1, emoji: "🔇" },
  kick:        { label: "🦶 Expulsión (Kick)",  color: 0xf97316, emoji: "🦶" },
  ban_temp:    { label: "🔨 Baneo Temporal",    color: 0xef4444, emoji: "🔨" },
  ban_perm:    { label: "⛔ Baneo Permanente",  color: 0x991b1b, emoji: "⛔" },
  jail:        { label: "🔒 Jail",              color: 0x78716c, emoji: "🔒" },
};

function tienePermiso(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (ROLES_PERMITIDOS.length === 0) return false;
  return ROLES_PERMITIDOS.some(id => member.roles.cache.has(id));
}

function crearEmbedSancion({ nickMinecraft, tipo, motivo, duracion, staff, guild }) {
  const s = TIPOS_SANCION[tipo]; const ahora = new Date();
  return new EmbedBuilder()
    .setTitle(`${s.emoji} Has recibido una sanción`).setColor(s.color)
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription(`Hola **${nickMinecraft}**, el equipo de staff del servidor **${guild.name}** te informa que has recibido la siguiente sanción:`)
    .addFields(
      { name: "⛏️ Nick Minecraft", value: nickMinecraft, inline: true },
      { name: "📋 Tipo", value: s.label, inline: true },
      { name: "📅 Fecha", value: `<t:${Math.floor(ahora.getTime()/1000)}:F>`, inline: true },
      ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
      { name: "📝 Motivo", value: motivo, inline: false },
      { name: "👮 Staff", value: staff.username, inline: false },
      { name: "ℹ️ Información", value: "Si considerás que esta sanción es injusta, podés apelarla contactando al equipo de moderación.", inline: false }
    )
    .setFooter({ text: `${guild.name} • Sistema de Sanciones`, iconURL: guild.iconURL({ dynamic: true }) })
    .setTimestamp(ahora);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once("ready", async () => {
  console.log(`✅ Bot: ${client.user.tag} | Servidores: ${client.guilds.cache.size}`);
  client.user.setActivity("⚖️ Gestionando sanciones", { type: 3 });
  await initDB();
  await registrarComandos();
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const [accion, nick, paginaStr] = interaction.customId.split("|");
    if (accion !== "sanciones") return;
    const pagina = parseInt(paginaStr);
    const r = await db.query("SELECT * FROM sanciones WHERE nick_minecraft=$1 ORDER BY created_at DESC", [nick.toLowerCase()]);
    const sanciones = r.rows;
    const totalPaginas = Math.max(1, Math.ceil(sanciones.length / 5));
    const embed = crearEmbedListaSanciones(sanciones, nick, pagina, totalPaginas);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanciones|${nick}|${pagina-1}`).setLabel("◀ Anterior").setStyle(ButtonStyle.Secondary).setDisabled(pagina===0),
      new ButtonBuilder().setCustomId(`sanciones|${nick}|${pagina+1}`).setLabel("Siguiente ▶").setStyle(ButtonStyle.Secondary).setDisabled(pagina>=totalPaginas-1)
    );
    return interaction.update({ embeds: [embed], components: [row] });
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === "web") {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("🌐 Panel de Administración")
        .setColor(0x5865f2)
        .setDescription(`Accedé al panel web de AventuraGuard para gestionar sanciones y vinculaciones.\n\n🔐 Iniciá sesión con tu cuenta de Discord.`)
        .addFields({ name: "🔗 URL", value: PANEL_URL })
        .setTimestamp()],
      flags: 64,
    });
  }

  if (commandName === "vincular") {
    const nick = interaction.options.getString("nick").trim();
    const userId = interaction.user.id;
    const existente = await db.query("SELECT user_id FROM vinculaciones WHERE nick_minecraft=$1", [nick.toLowerCase()]);
    if (existente.rows.length && existente.rows[0].user_id !== userId)
      return interaction.reply({ content: `❌ El nick **${nick}** ya está vinculado a otra cuenta.`, flags: 64 });
    await db.query(
      `INSERT INTO vinculaciones (nick_minecraft, user_id, username) VALUES ($1,$2,$3) ON CONFLICT (nick_minecraft) DO UPDATE SET user_id=$2, username=$3`,
      [nick.toLowerCase(), userId, interaction.user.username]
    );
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Cuenta vinculada")
      .setDescription(`Tu nick **${nick}** fue vinculado a tu Discord.`)
      .addFields({ name: "⛏️ Minecraft", value: nick, inline: true }, { name: "💬 Discord", value: interaction.user.username, inline: true })
      .setTimestamp()], flags: 64 });
  }

  if (commandName === "desvincular") {
    const r = await db.query("DELETE FROM vinculaciones WHERE user_id=$1 RETURNING nick_minecraft", [interaction.user.id]);
    if (!r.rows.length) return interaction.reply({ content: "❌ No tenés ninguna cuenta vinculada.", flags: 64 });
    return interaction.reply({ content: `✅ Tu nick **${r.rows[0].nick_minecraft}** fue desvinculado.`, flags: 64 });
  }

  if (commandName === "vinculaciones") {
    if (!tienePermiso(interaction.member)) return interaction.reply({ content: "❌ Sin permisos.", flags: 64 });
    const r = await db.query("SELECT * FROM vinculaciones ORDER BY created_at DESC");
    if (!r.rows.length) return interaction.reply({ content: "📭 No hay vinculaciones.", flags: 64 });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("📋 Vinculaciones")
      .setDescription(r.rows.map(row => `⛏️ **${row.nick_minecraft}** → <@${row.user_id}>`).join("\n"))
      .setFooter({ text: `Total: ${r.rows.length}` }).setTimestamp()], flags: 64 });
  }

  if (commandName === "notificar") {
    if (!tienePermiso(interaction.member)) return interaction.reply({ content: "❌ Sin permisos.", flags: 64 });
    await interaction.deferReply({ flags: 64 });
    const nickMinecraft = interaction.options.getString("nick_minecraft").trim();
    const motivo = interaction.options.getString("motivo");
    const tipo = interaction.options.getString("tipo");
    const duracion = interaction.options.getString("duracion");
    const staff = interaction.user; const guild = interaction.guild;
    const vinc = await db.query("SELECT * FROM vinculaciones WHERE nick_minecraft=$1", [nickMinecraft.toLowerCase()]);
    if (!vinc.rows.length) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Red)
      .setTitle("❌ No vinculado").setDescription(`**${nickMinecraft}** no tiene Discord vinculado.`)
      .addFields({ name: "Solución", value: `El jugador debe usar \`/vincular ${nickMinecraft}\`` }).setTimestamp()] });
    let usuarioTarget;
    try { usuarioTarget = await client.users.fetch(vinc.rows[0].user_id); } catch { return interaction.editReply({ content: "❌ No se pudo encontrar el usuario." }); }
    const embedSancion = crearEmbedSancion({ nickMinecraft, tipo, motivo, duracion, staff, guild });
    let dmEnviado = false;
    try { await usuarioTarget.send({ embeds: [embedSancion] }); dmEnviado = true; } catch {}
    await db.query(
      `INSERT INTO sanciones (nick_minecraft,user_id,username,tipo,motivo,duracion,staff_id,staff_username,guild_id,dm_enviado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [nickMinecraft.toLowerCase(), usuarioTarget.id, usuarioTarget.username, tipo, motivo, duracion, staff.id, staff.username, guild.id, dmEnviado]
    );
    const s = TIPOS_SANCION[tipo];
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(dmEnviado ? Colors.Green : Colors.Orange)
      .setTitle(dmEnviado ? "✅ Sanción notificada" : "⚠️ Registrada sin DM")
      .setDescription(dmEnviado ? `MD enviado a **${usuarioTarget.username}** (${nickMinecraft}).` : `DMs cerrados. Sanción registrada.`)
      .addFields({ name: "⛏️ Minecraft", value: nickMinecraft, inline: true }, { name: "📋 Tipo", value: s.label, inline: true }, { name: "📝 Motivo", value: motivo, inline: false })
      .setTimestamp()] });
  }

  if (commandName === "listasanciones") {
    if (!tienePermiso(interaction.member)) return interaction.reply({ content: "❌ Sin permisos.", flags: 64 });
    const nick = interaction.options.getString("nick_minecraft").trim();
    const r = await db.query("SELECT * FROM sanciones WHERE nick_minecraft=$1 ORDER BY created_at DESC", [nick.toLowerCase()]);
    const totalPaginas = Math.max(1, Math.ceil(r.rows.length / 5));
    const embed = crearEmbedListaSanciones(r.rows, nick, 0, totalPaginas);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanciones|${nick}|-1`).setLabel("◀ Anterior").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`sanciones|${nick}|1`).setLabel("Siguiente ▶").setStyle(ButtonStyle.Secondary).setDisabled(totalPaginas<=1)
    );
    return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  if (commandName === "todaslassanciones") {
    if (!tienePermiso(interaction.member)) return interaction.reply({ content: "❌ Sin permisos.", flags: 64 });
    const r = await db.query("SELECT * FROM sanciones ORDER BY created_at DESC LIMIT 20");
    if (!r.rows.length) return interaction.reply({ content: "📭 No hay sanciones.", flags: 64 });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("📋 Últimas 20 sanciones")
      .setDescription(r.rows.map((s,i) => {
        const tipo = TIPOS_SANCION[s.tipo]; const fecha = new Date(s.created_at);
        return `**#${i+1} — ${tipo.label}** · ⛏️ ${s.nick_minecraft} · <@${s.user_id}>\n📝 ${s.motivo} · 👮 ${s.staff_username} · <t:${Math.floor(fecha.getTime()/1000)}:D>`;
      }).join("\n\n")).setTimestamp()], flags: 64 });
  }
});

function crearEmbedListaSanciones(sanciones, nick, pagina, totalPaginas) {
  const embed = new EmbedBuilder().setTitle(`📋 Sanciones de ${nick}`).setColor(0x5865f2)
    .setFooter({ text: `Página ${pagina+1} de ${totalPaginas} · Total: ${sanciones.length}` }).setTimestamp();
  if (!sanciones.length) return embed.setDescription("✅ Sin sanciones registradas.");
  const items = sanciones.slice(pagina*5, pagina*5+5);
  embed.setDescription(items.map((s,i) => {
    const tipo = TIPOS_SANCION[s.tipo]; const fecha = new Date(s.created_at);
    return [`**#${pagina*5+i+1} — ${tipo.label}**`, `📝 ${s.motivo}`, s.duracion?`⏳ ${s.duracion}`:null, `👮 ${s.staff_username}`, `📅 <t:${Math.floor(fecha.getTime()/1000)}:D>`].filter(Boolean).join("\n");
  }).join("\n\n"));
  return embed;
}

client.on("error", e => console.error("❌", e));
process.on("unhandledRejection", e => console.error("❌", e));
client.login(process.env.TOKEN);
