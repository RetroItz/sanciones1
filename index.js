import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import dotenv from "dotenv";
import pg from "pg";
dotenv.config();

// ─── Base de datos ─────────────────────────────────────────────────────────────

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
  `);
  console.log("✅ Base de datos inicializada");
}

// ─── Configuración ─────────────────────────────────────────────────────────────

const ROLES_PERMITIDOS = [];
const CANAL_LOGS_ID = null;

// ─── Comandos ──────────────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("vincular")
    .setDescription("Vincula tu cuenta de Minecraft con tu Discord")
    .addStringOption((o) =>
      o.setName("nick").setDescription("Tu nick exacto en Minecraft").setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("desvincular")
    .setDescription("Desvincula tu cuenta de Minecraft de este Discord")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("vinculaciones")
    .setDescription("Muestra todas las vinculaciones Minecraft ↔ Discord (solo staff)")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("notificar")
    .setDescription("Notifica a un jugador que ha recibido una sanción")
    .addStringOption((o) =>
      o.setName("nick_minecraft").setDescription("Nick del jugador en Minecraft").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo").setDescription("Motivo de la sanción").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("tipo").setDescription("Tipo de sanción").setRequired(true)
        .addChoices(
          { name: "⚠️ Advertencia", value: "advertencia" },
          { name: "🔇 Silenciado (Mute)", value: "mute" },
          { name: "🦶 Expulsión (Kick)", value: "kick" },
          { name: "🔨 Baneo Temporal", value: "ban_temp" },
          { name: "⛔ Baneo Permanente", value: "ban_perm" },
          { name: "🔒 Jail", value: "jail" }
        )
    )
    .addStringOption((o) =>
      o.setName("duracion").setDescription("Duración (ej: 7 días)").setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("listasanciones")
    .setDescription("Ver el historial de sanciones de un jugador (solo staff)")
    .addStringOption((o) =>
      o.setName("nick_minecraft").setDescription("Nick del jugador en Minecraft").setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("todaslassanciones")
    .setDescription("Ver todas las sanciones del servidor (solo staff)")
    .toJSON(),
];

async function registrarComandos() {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("✅ Comandos slash registrados correctamente");
  } catch (error) {
    console.error("❌ Error al registrar comandos:", error);
  }
}

// ─── Cliente ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
  return ROLES_PERMITIDOS.some((roleId) => member.roles.cache.has(roleId));
}

function crearEmbedSancion({ nickMinecraft, tipo, motivo, duracion, staff, guild }) {
  const sancion = TIPOS_SANCION[tipo];
  const ahora = new Date();
  return new EmbedBuilder()
    .setTitle(`${sancion.emoji} Has recibido una sanción`)
    .setColor(sancion.color)
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription(`Hola **${nickMinecraft}**, el equipo de staff del servidor **${guild.name}** te informa que has recibido la siguiente sanción:`)
    .addFields(
      { name: "⛏️ Nick Minecraft",    value: nickMinecraft,  inline: true },
      { name: "📋 Tipo de Sanción",   value: sancion.label,  inline: true },
      { name: "📅 Fecha",             value: `<t:${Math.floor(ahora.getTime() / 1000)}:F>`, inline: true },
      ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
      { name: "📝 Motivo",            value: motivo,         inline: false },
      { name: "👮 Staff Responsable", value: staff.username, inline: false },
      { name: "ℹ️ Información", value: "Si considerás que esta sanción es injusta, podés apelarla contactando al equipo de moderación.", inline: false }
    )
    .setFooter({ text: `${guild.name} • Sistema de Sanciones`, iconURL: guild.iconURL({ dynamic: true }) })
    .setTimestamp(ahora);
}

function crearEmbedListaSanciones(sanciones, nickMinecraft, pagina, totalPaginas) {
  const embed = new EmbedBuilder()
    .setTitle(`📋 Sanciones de ${nickMinecraft}`)
    .setColor(0x5865f2)
    .setFooter({ text: `Página ${pagina + 1} de ${totalPaginas} • Total: ${sanciones.length} sanción(es)` })
    .setTimestamp();

  if (sanciones.length === 0) {
    embed.setDescription("✅ Este jugador no tiene sanciones registradas.");
    return embed;
  }

  const porPagina = 5;
  const inicio = pagina * porPagina;
  const items = sanciones.slice(inicio, inicio + porPagina);

  const descripcion = items.map((s, i) => {
    const sancion = TIPOS_SANCION[s.tipo];
    const fecha = new Date(s.created_at);
    return [
      `**#${inicio + i + 1} — ${sancion.label}**`,
      `📝 ${s.motivo}`,
      s.duracion ? `⏳ Duración: ${s.duracion}` : null,
      `👮 Staff: ${s.staff_username}`,
      `📅 <t:${Math.floor(fecha.getTime() / 1000)}:D>`,
      `💬 Discord: <@${s.user_id}>`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  embed.setDescription(descripcion);
  return embed;
}

// ─── Eventos ───────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  console.log(`📡 Servidores: ${client.guilds.cache.size}`);
  client.user.setActivity("⚖️ Gestionando sanciones", { type: 3 });
  await initDB();
  await registrarComandos();
});

client.on("interactionCreate", async (interaction) => {
  // ── Botones de paginación ──────────────────────────────────────────────────
  if (interaction.isButton()) {
    const [accion, nick, paginaStr] = interaction.customId.split("|");
    if (accion !== "sanciones") return;

    const pagina = parseInt(paginaStr);
    const result = await db.query(
      "SELECT * FROM sanciones WHERE nick_minecraft = $1 ORDER BY created_at DESC",
      [nick.toLowerCase()]
    );
    const sanciones = result.rows;
    const totalPaginas = Math.max(1, Math.ceil(sanciones.length / 5));

    const embed = crearEmbedListaSanciones(sanciones, nick, pagina, totalPaginas);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sanciones|${nick}|${pagina - 1}`)
        .setLabel("◀ Anterior")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pagina === 0),
      new ButtonBuilder()
        .setCustomId(`sanciones|${nick}|${pagina + 1}`)
        .setLabel("Siguiente ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pagina >= totalPaginas - 1)
    );

    return interaction.update({ embeds: [embed], components: [row] });
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /vincular ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "vincular") {
    const nick = interaction.options.getString("nick").trim();
    const userId = interaction.user.id;

    const existente = await db.query(
      "SELECT user_id FROM vinculaciones WHERE nick_minecraft = $1",
      [nick.toLowerCase()]
    );

    if (existente.rows.length > 0 && existente.rows[0].user_id !== userId) {
      return interaction.reply({
        content: `❌ El nick **${nick}** ya está vinculado a otra cuenta de Discord.`,
        flags: 64,
      });
    }

    await db.query(
      `INSERT INTO vinculaciones (nick_minecraft, user_id, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (nick_minecraft) DO UPDATE SET user_id = $2, username = $3`,
      [nick.toLowerCase(), userId, interaction.user.username]
    );

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Cuenta vinculada")
          .setDescription(`Tu nick de Minecraft **${nick}** ha sido vinculado a tu cuenta de Discord.`)
          .addFields(
            { name: "⛏️ Minecraft", value: nick, inline: true },
            { name: "💬 Discord", value: interaction.user.username, inline: true }
          )
          .setTimestamp()
      ],
      flags: 64,
    });
  }

  // ── /desvincular ───────────────────────────────────────────────────────────
  if (interaction.commandName === "desvincular") {
    const result = await db.query(
      "DELETE FROM vinculaciones WHERE user_id = $1 RETURNING nick_minecraft",
      [interaction.user.id]
    );

    if (result.rows.length === 0) {
      return interaction.reply({ content: "❌ No tenés ninguna cuenta de Minecraft vinculada.", flags: 64 });
    }

    return interaction.reply({
      content: `✅ Tu nick **${result.rows[0].nick_minecraft}** fue desvinculado correctamente.`,
      flags: 64,
    });
  }

  // ── /vinculaciones ─────────────────────────────────────────────────────────
  if (interaction.commandName === "vinculaciones") {
    if (!tienePermiso(interaction.member)) {
      return interaction.reply({ content: "❌ No tenés permisos para usar este comando.", flags: 64 });
    }

    const result = await db.query("SELECT * FROM vinculaciones ORDER BY created_at DESC");

    if (result.rows.length === 0) {
      return interaction.reply({ content: "📭 No hay vinculaciones registradas.", flags: 64 });
    }

    const lista = result.rows.map((r) => `⛏️ **${r.nick_minecraft}** → <@${r.user_id}>`).join("\n");

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📋 Vinculaciones Minecraft ↔ Discord")
          .setDescription(lista)
          .setFooter({ text: `Total: ${result.rows.length} vinculaciones` })
          .setTimestamp()
      ],
      flags: 64,
    });
  }

  // ── /notificar ─────────────────────────────────────────────────────────────
  if (interaction.commandName === "notificar") {
    if (!tienePermiso(interaction.member)) {
      return interaction.reply({ content: "❌ No tenés permisos para usar este comando.", flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const nickMinecraft = interaction.options.getString("nick_minecraft").trim();
    const motivo = interaction.options.getString("motivo");
    const tipo = interaction.options.getString("tipo");
    const duracion = interaction.options.getString("duracion");
    const staff = interaction.user;
    const guild = interaction.guild;

    const vinc = await db.query(
      "SELECT * FROM vinculaciones WHERE nick_minecraft = $1",
      [nickMinecraft.toLowerCase()]
    );

    if (vinc.rows.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Usuario no vinculado")
            .setDescription(`El nick **${nickMinecraft}** no tiene ninguna cuenta de Discord vinculada.`)
            .addFields({ name: "¿Qué hacer?", value: `El jugador debe usar \`/vincular ${nickMinecraft}\` en el Discord.` })
            .setTimestamp()
        ],
      });
    }

    let usuarioTarget;
    try {
      usuarioTarget = await client.users.fetch(vinc.rows[0].user_id);
    } catch {
      return interaction.editReply({ content: "❌ No se pudo encontrar el usuario de Discord vinculado." });
    }

    const embedSancion = crearEmbedSancion({ nickMinecraft, tipo, motivo, duracion, staff, guild });

    let dmEnviado = false;
    try {
      await usuarioTarget.send({ embeds: [embedSancion] });
      dmEnviado = true;
    } catch {
      dmEnviado = false;
    }

    await db.query(
      `INSERT INTO sanciones (nick_minecraft, user_id, username, tipo, motivo, duracion, staff_id, staff_username, guild_id, dm_enviado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [nickMinecraft.toLowerCase(), usuarioTarget.id, usuarioTarget.username, tipo, motivo, duracion, staff.id, staff.username, guild.id, dmEnviado]
    );

    if (CANAL_LOGS_ID) {
      try {
        const canalLogs = await guild.channels.fetch(CANAL_LOGS_ID);
        const sancionInfo = TIPOS_SANCION[tipo];
        if (canalLogs) {
          await canalLogs.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(`📋 Log — ${sancionInfo.label}`)
                .setColor(sancionInfo.color)
                .addFields(
                  { name: "⛏️ Minecraft", value: nickMinecraft, inline: true },
                  { name: "💬 Discord", value: `${usuarioTarget.username} (<@${usuarioTarget.id}>)`, inline: true },
                  { name: "👮 Staff", value: `${staff.username} (<@${staff.id}>)`, inline: true },
                  { name: "📋 Tipo", value: sancionInfo.label, inline: true },
                  ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
                  { name: "📝 Motivo", value: motivo, inline: false },
                  { name: "📨 DM Enviado", value: dmEnviado ? "✅ Sí" : "❌ No (DMs cerrados)", inline: true }
                )
                .setTimestamp()
                .setFooter({ text: `ID: ${usuarioTarget.id}` })
            ],
          });
        }
      } catch (err) {
        console.error("Error log:", err);
      }
    }

    const sancion = TIPOS_SANCION[tipo];
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(dmEnviado ? Colors.Green : Colors.Orange)
          .setTitle(dmEnviado ? "✅ Sanción notificada" : "⚠️ Sanción registrada (sin DM)")
          .setDescription(
            dmEnviado
              ? `Notificación enviada a **${usuarioTarget.username}** (${nickMinecraft}) por MD.`
              : `**${usuarioTarget.username}** tiene los DMs cerrados. Sanción registrada sin notificar.`
          )
          .addFields(
            { name: "⛏️ Minecraft", value: nickMinecraft, inline: true },
            { name: "💬 Discord",   value: usuarioTarget.username, inline: true },
            { name: "📋 Tipo",      value: sancion.label, inline: true },
            { name: "📝 Motivo",    value: motivo, inline: false }
          )
          .setTimestamp()
      ],
    });
  }

  // ── /listasanciones ────────────────────────────────────────────────────────
  if (interaction.commandName === "listasanciones") {
    if (!tienePermiso(interaction.member)) {
      return interaction.reply({ content: "❌ No tenés permisos para usar este comando.", flags: 64 });
    }

    const nickMinecraft = interaction.options.getString("nick_minecraft").trim();

    const result = await db.query(
      "SELECT * FROM sanciones WHERE nick_minecraft = $1 ORDER BY created_at DESC",
      [nickMinecraft.toLowerCase()]
    );

    const sanciones = result.rows;
    const totalPaginas = Math.max(1, Math.ceil(sanciones.length / 5));
    const embed = crearEmbedListaSanciones(sanciones, nickMinecraft, 0, totalPaginas);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sanciones|${nickMinecraft}|${-1}`)
        .setLabel("◀ Anterior")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`sanciones|${nickMinecraft}|${1}`)
        .setLabel("Siguiente ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(totalPaginas <= 1)
    );

    return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  // ── /todaslassanciones ─────────────────────────────────────────────────────
  if (interaction.commandName === "todaslassanciones") {
    if (!tienePermiso(interaction.member)) {
      return interaction.reply({ content: "❌ No tenés permisos para usar este comando.", flags: 64 });
    }

    const result = await db.query(
      "SELECT * FROM sanciones ORDER BY created_at DESC LIMIT 20"
    );

    if (result.rows.length === 0) {
      return interaction.reply({ content: "📭 No hay sanciones registradas.", flags: 64 });
    }

    const descripcion = result.rows.map((s, i) => {
      const sancion = TIPOS_SANCION[s.tipo];
      const fecha = new Date(s.created_at);
      return `**#${i + 1} — ${sancion.label}** · ⛏️ ${s.nick_minecraft} · <@${s.user_id}>\n📝 ${s.motivo} · 👮 ${s.staff_username} · <t:${Math.floor(fecha.getTime() / 1000)}:D>`;
    }).join("\n\n");

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📋 Últimas 20 sanciones del servidor")
          .setDescription(descripcion)
          .setTimestamp()
      ],
      flags: 64,
    });
  }
});

client.on("error", (error) => console.error("❌ Error:", error));
process.on("unhandledRejection", (error) => console.error("❌ Promesa rechazada:", error));

client.login(process.env.TOKEN);
