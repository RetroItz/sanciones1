// ═══════════════════════════════════════════════════════════════════════════════
// AventuraGuard — Bot completo
// Sanciones + Vinculaciones + Sugerencias + Tickets + Panel Web
// ═══════════════════════════════════════════════════════════════════════════════
import {
  Client, GatewayIntentBits, EmbedBuilder, Colors, PermissionFlagsBits,
  REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, ChannelType, AttachmentBuilder, Partials,
} from "discord.js";
import express from "express";
import cors from "cors";
import session from "express-session";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

// ─── BASE DE DATOS ─────────────────────────────────────────────────────────────
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS vinculaciones (
      nick_minecraft TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, username TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sanciones (
      id SERIAL PRIMARY KEY, nick_minecraft TEXT NOT NULL,
      user_id TEXT NOT NULL, username TEXT NOT NULL,
      tipo TEXT NOT NULL, motivo TEXT NOT NULL, duracion TEXT,
      staff_id TEXT NOT NULL, staff_username TEXT NOT NULL,
      guild_id TEXT NOT NULL, dm_enviado BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS staff_sessions (
      discord_id TEXT PRIMARY KEY, username TEXT NOT NULL,
      avatar TEXT, access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS suggestions_config (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets_config (
      guild_id TEXT PRIMARY KEY, log_channel_id TEXT,
      category_id TEXT NOT NULL, staff_role_id TEXT NOT NULL,
      panel_channel_id TEXT, panel_message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
      username TEXT NOT NULL, category TEXT NOT NULL,
      claimed_by_id TEXT, claimed_by_name TEXT,
      status TEXT DEFAULT 'open', transcript TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), closed_at TIMESTAMPTZ
    );
  `);
  console.log("✅ Base de datos inicializada");
}

// ─── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
const ROLES_PERMITIDOS = [];
const CANAL_LOGS_ID = null;
const DISCORD_CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const PANEL_URL = process.env.PANEL_URL || "http://localhost:3000";
const API_URL = (process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");
const ENSURE_HTTPS = (url) => url.startsWith("http") ? url : `https://${url}`;
const REDIRECT_URI = `${ENSURE_HTTPS(API_URL)}/auth/callback`;

// ─── TIPOS DE SANCIÓN ──────────────────────────────────────────────────────────
const TIPOS_SANCION = {
  advertencia: { label: "⚠️ Advertencia",      color: 0xf59e0b, emoji: "⚠️" },
  mute:        { label: "🔇 Silenciado (Mute)", color: 0x6366f1, emoji: "🔇" },
  kick:        { label: "🦶 Expulsión (Kick)",  color: 0xf97316, emoji: "🦶" },
  ban_temp:    { label: "🔨 Baneo Temporal",    color: 0xef4444, emoji: "🔨" },
  ban_perm:    { label: "⛔ Baneo Permanente",  color: 0x991b1b, emoji: "⛔" },
  jail:        { label: "🔒 Jail",              color: 0x78716c, emoji: "🔒" },
};

// ─── CATEGORÍAS DE TICKETS ────────────────────────────────────────────────────
const TICKET_CATS = {
  soporte:    { label: "Soporte General",   emoji: "🛠️", color: 0x5865f2 },
  bug:        { label: "Reportar Bug",      emoji: "🐛", color: 0xfaa61a },
  reporte:    { label: "Reportar Usuario",  emoji: "🚨", color: 0xed4245 },
  sugerencia: { label: "Sugerencia",        emoji: "💡", color: 0x3ba55d },
  otro:       { label: "Otro",              emoji: "📝", color: 0x99aab5 },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────
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
      { name: "ℹ️ Info", value: "Si considerás que esta sanción es injusta, contactá al equipo de moderación.", inline: false }
    )
    .setFooter({ text: `${guild.name} • Sistema de Sanciones`, iconURL: guild.iconURL({ dynamic: true }) })
    .setTimestamp(ahora);
}

function crearEmbedListaSanciones(sanciones, nick, pagina, totalPaginas) {
  const embed = new EmbedBuilder().setTitle(`📋 Sanciones de ${nick}`).setColor(0x5865f2)
    .setFooter({ text: `Página ${pagina+1} de ${totalPaginas} · Total: ${sanciones.length}` }).setTimestamp();
  if (!sanciones.length) return embed.setDescription("✅ Sin sanciones registradas.");
  const items = sanciones.slice(pagina*5, pagina*5+5);
  embed.setDescription(items.map((s,i) => {
    const tipo = TIPOS_SANCION[s.tipo]; const fecha = new Date(s.created_at);
    return [`**#${pagina*5+i+1} — ${tipo.label}**`, `📝 ${s.motivo}`,
      s.duracion?`⏳ ${s.duracion}`:null, `👮 ${s.staff_username}`,
      `📅 <t:${Math.floor(fecha.getTime()/1000)}:D>`].filter(Boolean).join("\n");
  }).join("\n\n"));
  return embed;
}

async function generateTranscript(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const sorted = [...messages.values()].reverse();
    const rows = sorted.map(m => {
      const time = new Date(m.createdTimestamp).toLocaleString("es");
      const embeds = m.embeds.map(e =>
        `<div style="border-left:4px solid #5865f2;padding:8px;margin:4px 0;background:#2f3136;">
          ${e.title?`<div style="font-weight:700;color:#fff">${e.title}</div>`:""}
          ${e.description?`<div style="font-size:13px">${e.description}</div>`:""}
        </div>`).join("");
      return `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #40444b">
        <img src="${m.author.displayAvatarURL({size:32})}" style="width:32px;height:32px;border-radius:50%"/>
        <div><span style="font-weight:700;color:#fff">${m.author.username}</span>
        <span style="font-size:11px;color:#72767d;margin-left:8px">${time}</span>
        <div style="margin-top:4px;font-size:14px">${m.content||""}</div>${embeds}</div></div>`;
    }).join("");
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Ticket — #${channel.name}</title></head>
<body style="background:#36393f;color:#dcddde;font-family:sans-serif;padding:20px">
<h1 style="color:#fff;border-bottom:1px solid #4f545c;padding-bottom:10px">📋 #${channel.name}</h1>
<p style="color:#72767d;font-size:13px">Generado: ${new Date().toLocaleString("es")}</p>
${rows}
<p style="text-align:center;font-size:12px;color:#72767d;margin-top:20px">AventuraGuard • Sistema de Tickets</p>
</body></html>`;
  } catch { return null; }
}

// ─── EXPRESS API ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: PANEL_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "aventuraguard-secret-key",
  resave: false, saveUninitialized: false,
  cookie: { secure: false, maxAge: 7*24*60*60*1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "No autenticado" });
  next();
}

app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: "code", scope: "identify",
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
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();
    let isStaff = true;
    req.session.user = {
      id: userData.id, username: userData.username,
      avatar: userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
    };
    res.redirect(`${PANEL_URL.replace(/\/+$/, "")}/dashboard`);
  } catch (err) {
    console.error("Auth error:", err);
    res.redirect(`${PANEL_URL}/login?error=auth_failed`);
  }
});

app.get("/auth/me", requireAuth, (req, res) => res.json(req.session.user));
app.post("/auth/logout", (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get("/api/sanciones", requireAuth, async (req, res) => {
  const { nick, motivo, tipo, page = 1 } = req.query;
  const limit = 20; const offset = (page-1)*limit;
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
      const s = TIPOS_SANCION[tipo];
      await user.send({ embeds: [new EmbedBuilder().setTitle(`${s.emoji} Has recibido una sanción`).setColor(s.color)
        .setDescription(`Hola **${nick_minecraft}**, recibiste la siguiente sanción:`)
        .addFields(
          { name: "📋 Tipo", value: s.label, inline: true },
          { name: "📅 Fecha", value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true },
          ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
          { name: "📝 Motivo", value: motivo, inline: false },
          { name: "👮 Staff", value: staff.username, inline: false },
        ).setTimestamp()] });
      dmEnviado = true;
    } catch {}
  }
  const r = await db.query(
    `INSERT INTO sanciones (nick_minecraft,user_id,username,tipo,motivo,duracion,staff_id,staff_username,guild_id,dm_enviado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [nick_minecraft.toLowerCase(), userId, username, tipo, motivo, duracion||null, staff.id, staff.username, guild?.id||"web", dmEnviado]
  );
  res.json(r.rows[0]);
});

app.put("/api/sanciones/:id", requireAuth, async (req, res) => {
  const { motivo, tipo, duracion } = req.body;
  const r = await db.query("UPDATE sanciones SET motivo=$1,tipo=$2,duracion=$3 WHERE id=$4 RETURNING *", [motivo, tipo, duracion||null, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "No encontrado" });
  res.json(r.rows[0]);
});

app.delete("/api/sanciones/:id", requireAuth, async (req, res) => {
  await db.query("DELETE FROM sanciones WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/vinculaciones", requireAuth, async (req, res) => {
  const r = await db.query("SELECT * FROM vinculaciones ORDER BY created_at DESC");
  res.json(r.rows);
});

app.delete("/api/vinculaciones/:nick", requireAuth, async (req, res) => {
  await db.query("DELETE FROM vinculaciones WHERE nick_minecraft = $1", [req.params.nick]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API corriendo en puerto ${PORT}`));

// ─── COMANDOS SLASH ────────────────────────────────────────────────────────────
const commands = [
  // Sanciones
  new SlashCommandBuilder().setName("vincular").setDescription("Vincula tu cuenta de Minecraft con tu Discord")
    .addStringOption(o => o.setName("nick").setDescription("Tu nick exacto en Minecraft").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("desvincular").setDescription("Desvincula tu cuenta de Minecraft").toJSON(),
  new SlashCommandBuilder().setName("vinculaciones").setDescription("Muestra todas las vinculaciones (solo staff)").toJSON(),
  new SlashCommandBuilder().setName("notificar").setDescription("Notifica a un jugador que ha recibido una sanción")
    .addStringOption(o => o.setName("nick_minecraft").setDescription("Nick del jugador en Minecraft").setRequired(true))
    .addStringOption(o => o.setName("motivo").setDescription("Motivo de la sanción").setRequired(true))
    .addStringOption(o => o.setName("tipo").setDescription("Tipo de sanción").setRequired(true)
      .addChoices(
        { name: "⚠️ Advertencia", value: "advertencia" }, { name: "🔇 Mute", value: "mute" },
        { name: "🦶 Kick", value: "kick" }, { name: "🔨 Ban Temporal", value: "ban_temp" },
        { name: "⛔ Ban Permanente", value: "ban_perm" }, { name: "🔒 Jail", value: "jail" }
      ))
    .addStringOption(o => o.setName("duracion").setDescription("Duración (ej: 7 días)").setRequired(false)).toJSON(),
  new SlashCommandBuilder().setName("listasanciones").setDescription("Ver historial de sanciones (solo staff)")
    .addStringOption(o => o.setName("nick_minecraft").setDescription("Nick del jugador").setRequired(true)).toJSON(),
  new SlashCommandBuilder().setName("todaslassanciones").setDescription("Ver todas las sanciones (solo staff)").toJSON(),
  new SlashCommandBuilder().setName("web").setDescription("Abre el panel de administración web").toJSON(),
  // Sugerencias
  new SlashCommandBuilder().setName("setup-suggestions").setDescription("Configura el canal de sugerencias")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("canal").setDescription("Canal de sugerencias").setRequired(true)).toJSON(),
  // Tickets
  new SlashCommandBuilder().setName("setup-tickets").setDescription("Configura el sistema de tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName("staff").setDescription("Rol de Staff").setRequired(true))
    .addChannelOption(o => o.setName("categoria").setDescription("Categoría para los canales de tickets").setRequired(true))
    .addChannelOption(o => o.setName("panel").setDescription("Canal donde se enviará el panel").setRequired(true))
    .addChannelOption(o => o.setName("logs").setDescription("Canal de logs (opcional)").setRequired(false)).toJSON(),
];

async function registrarComandos() {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("✅ Comandos slash registrados");
  } catch (e) { console.error("❌ Error comandos:", e); }
}

// ─── CLIENTE ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── EVENTO: READY ─────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ Bot: ${client.user.tag} | Servidores: ${client.guilds.cache.size}`);
  client.user.setActivity("⚖️ AventuraGuard", { type: 3 });
  await initDB();
  await registrarComandos();
});

// ─── EVENTO: MESSAGE CREATE (Sugerencias) ──────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guildId) return;
  const config = await db.query("SELECT * FROM suggestions_config WHERE guild_id = $1", [message.guildId]);
  if (!config.rows.length || message.channelId !== config.rows[0].channel_id) return;
  try { await message.delete(); } catch {}
  const embed = new EmbedBuilder()
    .setColor(0x5865f2).setTitle("💡 Nueva Sugerencia")
    .setDescription(message.content)
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
    .setFooter({ text: `Sugerencias • ${message.guild.name}` }).setTimestamp();
  const sent = await message.channel.send({ embeds: [embed] });
  await sent.react("👍");
  await sent.react("👎");
});

// ─── EVENTO: INTERACTION CREATE ────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── Paginación de sanciones ────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("sanciones|")) {
    const [, nick, paginaStr] = interaction.customId.split("|");
    const pagina = parseInt(paginaStr);
    const r = await db.query("SELECT * FROM sanciones WHERE nick_minecraft=$1 ORDER BY created_at DESC", [nick.toLowerCase()]);
    const totalPaginas = Math.max(1, Math.ceil(r.rows.length/5));
    const embed = crearEmbedListaSanciones(r.rows, nick, pagina, totalPaginas);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanciones|${nick}|${pagina-1}`).setLabel("◀ Anterior").setStyle(ButtonStyle.Secondary).setDisabled(pagina===0),
      new ButtonBuilder().setCustomId(`sanciones|${nick}|${pagina+1}`).setLabel("Siguiente ▶").setStyle(ButtonStyle.Secondary).setDisabled(pagina>=totalPaginas-1)
    );
    return interaction.update({ embeds: [embed], components: [row] });
  }

  // ── Botón: Abrir Ticket ────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "ticket_open") {
    const modal = new ModalBuilder().setCustomId("ticket_modal").setTitle("Abrir Ticket");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("ticket_motivo").setLabel("¿En qué podemos ayudarte?")
        .setStyle(TextInputStyle.Paragraph).setPlaceholder("Describí brevemente tu consulta...").setRequired(true).setMaxLength(500)
    ));
    return interaction.showModal(modal);
  }

  // ── Modal Submit: Ticket ───────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "ticket_modal") {
    const motivo = interaction.fields.getTextInputValue("ticket_motivo");
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`ticket_cat|${encodeURIComponent(motivo)}`)
        .setPlaceholder("Seleccioná la categoría...")
        .addOptions(Object.entries(TICKET_CATS).map(([value, cat]) => ({
          label: cat.label, value, emoji: cat.emoji,
        })))
    );
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("🎫 Categoría del Ticket").setDescription("Elegí la categoría que mejor describe tu consulta:")],
      components: [row], ephemeral: true,
    });
  }

  // ── Select: Categoría Ticket ───────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("ticket_cat|")) {
    const motivo = decodeURIComponent(interaction.customId.split("|")[1]);
    const categoria = interaction.values[0];
    const cat = TICKET_CATS[categoria];
    await interaction.deferUpdate();

    const config = await db.query("SELECT * FROM tickets_config WHERE guild_id = $1", [interaction.guildId]);
    if (!config.rows.length)
      return interaction.followUp({ content: "❌ El sistema de tickets no está configurado.", ephemeral: true });
    const cfg = config.rows[0];

    const existing = await db.query(
      "SELECT * FROM tickets WHERE guild_id=$1 AND user_id=$2 AND status='open'",
      [interaction.guildId, interaction.user.id]
    );
    if (existing.rows.length) {
      const ch = interaction.guild.channels.cache.get(existing.rows[0].channel_id);
      return interaction.followUp({ content: `❌ Ya tenés un ticket abierto: ${ch||"(canal eliminado)"}`, ephemeral: true });
    }

    const nombre = `${categoria}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,15)}`;
    const canal = await interaction.guild.channels.create({
      name: nombre, type: ChannelType.GuildText, parent: cfg.category_id,
      permissionOverwrites: [
        { id: interaction.guildId, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: cfg.staff_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      ],
    });

    const ticketRes = await db.query(
      `INSERT INTO tickets (guild_id,channel_id,user_id,username,category) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [interaction.guildId, canal.id, interaction.user.id, interaction.user.username, categoria]
    );
    const ticketId = ticketRes.rows[0].id;

    const bienvenidaEmbed = new EmbedBuilder().setColor(cat.color)
      .setTitle(`${cat.emoji} Ticket Abierto — ${cat.label}`)
      .setDescription(
        `Bienvenid@ **${interaction.user.username}**.\n` +
        `Un miembro del staff te atenderá pronto.\n\n` +
        `**📋 Información:**\n` +
        `🎫 **Ticket Nº:** ${ticketId}\n` +
        `📁 **Categoría:** ${cat.emoji} ${cat.label}\n` +
        `📝 **Motivo:** ${motivo}\n` +
        `👤 **Abierto por:** ${interaction.user.username}\n` +
        `🆔 **ID del usuario:** ${interaction.user.id}`
      )
      .setFooter({ text: `${interaction.guild.name} • Tickets`, iconURL: interaction.guild.iconURL({ dynamic: true }) })
      .setTimestamp();

    const botonesRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket_close|${ticketId}`).setLabel("Cerrar Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket_claim|${ticketId}`).setLabel("Reclamar Ticket").setEmoji("✋").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ticket_transcript|${ticketId}`).setLabel("Transcripción").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    );

    const staffRole = interaction.guild.roles.cache.get(cfg.staff_role_id);
    await canal.send({ content: `${interaction.user} | ${staffRole}`, embeds: [bienvenidaEmbed], components: [botonesRow] });

    if (cfg.log_channel_id) {
      const logCanal = interaction.guild.channels.cache.get(cfg.log_channel_id);
      if (logCanal) await logCanal.send({ embeds: [new EmbedBuilder().setColor(cat.color)
        .setTitle(`📋 Nuevo Ticket #${ticketId}`)
        .addFields(
          { name: "👤 Usuario", value: `${interaction.user} (${interaction.user.id})`, inline: true },
          { name: "📁 Categoría", value: `${cat.emoji} ${cat.label}`, inline: true },
          { name: "📝 Motivo", value: motivo, inline: false },
          { name: "📌 Canal", value: `${canal}`, inline: true },
        ).setTimestamp()] });
    }

    return interaction.followUp({ content: `✅ Tu ticket fue abierto en ${canal}.`, ephemeral: true });
  }

  // ── Botón: Reclamar Ticket ─────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("ticket_claim|")) {
    const ticketId = interaction.customId.split("|")[1];
    const config = await db.query("SELECT * FROM tickets_config WHERE guild_id = $1", [interaction.guildId]);
    if (!config.rows.length) return;
    const isStaff = interaction.member.roles.cache.has(config.rows[0].staff_role_id) || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isStaff) return interaction.reply({ content: "❌ Solo el staff puede reclamar tickets.", ephemeral: true });
    const ticket = await db.query("SELECT * FROM tickets WHERE id = $1", [ticketId]);
    if (!ticket.rows.length) return;
    if (ticket.rows[0].claimed_by_id)
      return interaction.reply({ content: `❌ Ya reclamado por **${ticket.rows[0].claimed_by_name}**.`, ephemeral: true });
    await db.query("UPDATE tickets SET claimed_by_id=$1, claimed_by_name=$2 WHERE id=$3",
      [interaction.user.id, interaction.user.username, ticketId]);
    const nuevoNombre = `${ticket.rows[0].category}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,15)}`;
    try { await interaction.channel.setName(nuevoNombre); } catch {}
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3ba55d)
      .setTitle("✅ Ticket Reclamado")
      .setDescription(`Reclamado por **${interaction.user}**. Será atendido por ${interaction.user.username}.`)
      .setTimestamp()] });
  }

  // ── Botón: Cerrar Ticket ───────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("ticket_close|")) {
    const ticketId = interaction.customId.split("|")[1];
    const config = await db.query("SELECT * FROM tickets_config WHERE guild_id = $1", [interaction.guildId]);
    if (!config.rows.length) return;
    const ticket = await db.query("SELECT * FROM tickets WHERE id = $1", [ticketId]);
    if (!ticket.rows.length) return;
    const isStaff = interaction.member.roles.cache.has(config.rows[0].staff_role_id) || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isOwner = interaction.user.id === ticket.rows[0].user_id;
    if (!isStaff && !isOwner) return interaction.reply({ content: "❌ Sin permisos.", ephemeral: true });
    await interaction.deferReply();
    const html = await generateTranscript(interaction.channel);
    const attachment = html ? new AttachmentBuilder(Buffer.from(html, "utf-8"), { name: `ticket-${ticketId}.html` }) : null;
    await db.query("UPDATE tickets SET status='closed', closed_at=NOW() WHERE id=$1", [ticketId]);
    if (config.rows[0].log_channel_id) {
      const logCanal = interaction.guild.channels.cache.get(config.rows[0].log_channel_id);
      if (logCanal) await logCanal.send({
        embeds: [new EmbedBuilder().setColor(0xed4245).setTitle(`🔒 Ticket Cerrado #${ticketId}`)
          .addFields(
            { name: "👤 Usuario", value: `<@${ticket.rows[0].user_id}>`, inline: true },
            { name: "👮 Cerrado por", value: `${interaction.user}`, inline: true },
            { name: "📁 Categoría", value: `${TICKET_CATS[ticket.rows[0].category]?.emoji} ${TICKET_CATS[ticket.rows[0].category]?.label}`, inline: true },
          ).setTimestamp()],
        files: attachment ? [attachment] : [],
      });
    }
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle("🔒 Cerrando Ticket")
        .setDescription("Canal eliminado en **5 segundos**.").setTimestamp()],
      files: attachment ? [attachment] : [],
    });
    setTimeout(async () => { try { await interaction.channel.delete(); } catch {} }, 5000);
  }

  // ── Botón: Transcripción ───────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("ticket_transcript|")) {
    const ticketId = interaction.customId.split("|")[1];
    const config = await db.query("SELECT * FROM tickets_config WHERE guild_id = $1", [interaction.guildId]);
    if (!config.rows.length) return;
    const isStaff = interaction.member.roles.cache.has(config.rows[0].staff_role_id) || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isStaff) return interaction.reply({ content: "❌ Solo el staff.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const html = await generateTranscript(interaction.channel);
    if (!html) return interaction.editReply({ content: "❌ No se pudo generar la transcripción." });
    const attachment = new AttachmentBuilder(Buffer.from(html, "utf-8"), { name: `ticket-${ticketId}.html` });
    return interaction.editReply({ content: "📋 Transcripción generada:", files: [attachment] });
  }

  // ── Slash Commands ─────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // /web
  if (commandName === "web") {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
      .setTitle("🌐 Panel de Administración")
      .setDescription(`Accedé al panel web de AventuraGuard.\n\n🔐 Iniciá sesión con Discord.`)
      .addFields({ name: "🔗 URL", value: PANEL_URL }).setTimestamp()], flags: 64 });
  }

  // /setup-suggestions
  if (commandName === "setup-suggestions") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ Solo administradores.", ephemeral: true });
    const canal = interaction.options.getChannel("canal");
    await db.query(
      `INSERT INTO suggestions_config (guild_id, channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET channel_id=$2`,
      [interaction.guildId, canal.id]
    );
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
      .setTitle("✅ Sistema de Sugerencias Configurado")
      .setDescription(`Canal configurado: ${canal}\n\nLos mensajes serán convertidos automáticamente en sugerencias con reacciones 👍 👎`)
      .setTimestamp()], ephemeral: true });
  }

  // /setup-tickets
  if (commandName === "setup-tickets") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ Solo administradores.", ephemeral: true });
    const staffRole  = interaction.options.getRole("staff");
    const categoria  = interaction.options.getChannel("categoria");
    const panelCanal = interaction.options.getChannel("panel");
    const logsCanal  = interaction.options.getChannel("logs");
    if (categoria.type !== ChannelType.GuildCategory)
      return interaction.reply({ content: "❌ El canal debe ser una **categoría** de Discord.", ephemeral: true });
    const panelEmbed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle("🎫 Sistema de Tickets")
      .setDescription(
        "¿Necesitás ayuda? Abrí un ticket y el staff te atenderá pronto.\n\n" +
        "**📋 Podés usar tickets para:**\n• Soporte general\n• Reportar bugs\n• Reportar usuarios\n• Sugerencias\n• Otros temas"
      )
      .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL({ dynamic: true }) }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_open").setLabel("Abrir Ticket").setEmoji("🎫").setStyle(ButtonStyle.Primary)
    );
    const panelMsg = await panelCanal.send({ embeds: [panelEmbed], components: [row] });
    await db.query(
      `INSERT INTO tickets_config (guild_id,log_channel_id,category_id,staff_role_id,panel_channel_id,panel_message_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (guild_id) DO UPDATE SET
       log_channel_id=$2, category_id=$3, staff_role_id=$4, panel_channel_id=$5, panel_message_id=$6`,
      [interaction.guildId, logsCanal?.id||null, categoria.id, staffRole.id, panelCanal.id, panelMsg.id]
    );
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3ba55d)
      .setTitle("✅ Sistema de Tickets Configurado")
      .addFields(
        { name: "🎫 Panel", value: `${panelCanal}`, inline: true },
        { name: "📁 Categoría", value: categoria.name, inline: true },
        { name: "👮 Staff", value: `${staffRole}`, inline: true },
        { name: "📋 Logs", value: logsCanal ? `${logsCanal}` : "No configurado", inline: true },
      ).setTimestamp()], ephemeral: true });
  }

  // /vincular
  if (commandName === "vincular") {
    const nick = interaction.options.getString("nick").trim();
    const userId = interaction.user.id;
    const existente = await db.query("SELECT user_id FROM vinculaciones WHERE nick_minecraft=$1", [nick.toLowerCase()]);
    if (existente.rows.length && existente.rows[0].user_id !== userId)
      return interaction.reply({ content: `❌ El nick **${nick}** ya está vinculado a otra cuenta.`, flags: 64 });
    await db.query(
      `INSERT INTO vinculaciones (nick_minecraft,user_id,username) VALUES ($1,$2,$3) ON CONFLICT (nick_minecraft) DO UPDATE SET user_id=$2, username=$3`,
      [nick.toLowerCase(), userId, interaction.user.username]
    );
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle("✅ Cuenta vinculada")
      .setDescription(`Tu nick **${nick}** fue vinculado a tu Discord.`)
      .addFields({ name: "⛏️ Minecraft", value: nick, inline: true }, { name: "💬 Discord", value: interaction.user.username, inline: true })
      .setTimestamp()], flags: 64 });
  }

  // /desvincular
  if (commandName === "desvincular") {
    const r = await db.query("DELETE FROM vinculaciones WHERE user_id=$1 RETURNING nick_minecraft", [interaction.user.id]);
    if (!r.rows.length) return interaction.reply({ content: "❌ No tenés ninguna cuenta vinculada.", flags: 64 });
    return interaction.reply({ content: `✅ Tu nick **${r.rows[0].nick_minecraft}** fue desvinculado.`, flags: 64 });
  }

  // /vinculaciones
  if (commandName === "vinculaciones") {
    if (!tienePermiso(interaction.member)) return interaction.reply({ content: "❌ Sin permisos.", flags: 64 });
    const r = await db.query("SELECT * FROM vinculaciones ORDER BY created_at DESC");
    if (!r.rows.length) return interaction.reply({ content: "📭 No hay vinculaciones.", flags: 64 });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("📋 Vinculaciones")
      .setDescription(r.rows.map(row => `⛏️ **${row.nick_minecraft}** → <@${row.user_id}>`).join("\n"))
      .setFooter({ text: `Total: ${r.rows.length}` }).setTimestamp()], flags: 64 });
  }

  // /notificar
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
    try { usuarioTarget = await client.users.fetch(vinc.rows[0].user_id); }
    catch { return interaction.editReply({ content: "❌ No se pudo encontrar el usuario." }); }
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
      .setDescription(dmEnviado ? `MD enviado a **${usuarioTarget.username}** (${nickMinecraft}).` : `DMs cerrados. Registrada.`)
      .addFields({ name: "⛏️ Minecraft", value: nickMinecraft, inline: true }, { name: "📋 Tipo", value: s.label, inline: true }, { name: "📝 Motivo", value: motivo, inline: false })
      .setTimestamp()] });
  }

  // /listasanciones
  if (commandName === "listasanciones") {
    if (!tienePermiso(interaction.member)) return interaction.reply({ content: "❌ Sin permisos.", flags: 64 });
    const nick = interaction.options.getString("nick_minecraft").trim();
    const r = await db.query("SELECT * FROM sanciones WHERE nick_minecraft=$1 ORDER BY created_at DESC", [nick.toLowerCase()]);
    const totalPaginas = Math.max(1, Math.ceil(r.rows.length/5));
    const embed = crearEmbedListaSanciones(r.rows, nick, 0, totalPaginas);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanciones|${nick}|-1`).setLabel("◀ Anterior").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`sanciones|${nick}|1`).setLabel("Siguiente ▶").setStyle(ButtonStyle.Secondary).setDisabled(totalPaginas<=1)
    );
    return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  // /todaslassanciones
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

client.on("error", e => console.error("❌", e));
process.on("unhandledRejection", e => console.error("❌", e));
client.login(process.env.TOKEN);
