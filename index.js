import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import dotenv from "dotenv";
dotenv.config();

// ─── Configuración ─────────────────────────────────────────────────────────────

const ROLES_PERMITIDOS = [];
const CANAL_LOGS_ID = null;

// Base de datos en memoria: { "nickMinecraft": userId }
const vinculaciones = new Map();

// ─── Comandos ──────────────────────────────────────────────────────────────────

const commands = [
  // /vincular - para que los jugadores vinculen su cuenta
  new SlashCommandBuilder()
    .setName("vincular")
    .setDescription("Vincula tu cuenta de Minecraft con tu Discord")
    .addStringOption((o) =>
      o.setName("nick").setDescription("Tu nick exacto en Minecraft").setRequired(true)
    )
    .toJSON(),

  // /desvincular - para quitar la vinculación
  new SlashCommandBuilder()
    .setName("desvincular")
    .setDescription("Desvincula tu cuenta de Minecraft de este Discord")
    .toJSON(),

  // /vinculaciones - para que el staff vea todas las vinculaciones
  new SlashCommandBuilder()
    .setName("vinculaciones")
    .setDescription("Muestra todas las vinculaciones Minecraft ↔ Discord (solo staff)")
    .toJSON(),

  // /notificar - para sancionar
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
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
    .setDescription(
      `Hola **${nickMinecraft}**, el equipo de staff del servidor **${guild.name}** te informa que has recibido la siguiente sanción:`
    )
    .addFields(
      { name: "⛏️ Nick Minecraft",   value: nickMinecraft,  inline: true },
      { name: "📋 Tipo de Sanción",  value: sancion.label,  inline: true },
      { name: "📅 Fecha",            value: `<t:${Math.floor(ahora.getTime() / 1000)}:F>`, inline: true },
      ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
      { name: "📝 Motivo",           value: motivo,         inline: false },
      { name: "👮 Staff Responsable", value: staff.username, inline: false },
      {
        name: "ℹ️ Información",
        value: "Si considerás que esta sanción es injusta, podés apelarla contactando al equipo de moderación del servidor.",
        inline: false,
      }
    )
    .setFooter({
      text: `${guild.name} • Sistema de Sanciones`,
      iconURL: guild.iconURL({ dynamic: true }),
    })
    .setTimestamp(ahora);
}

// ─── Eventos ───────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  console.log(`📡 Servidores: ${client.guilds.cache.size}`);
  client.user.setActivity("⚖️ Gestionando sanciones", { type: 3 });
  await registrarComandos();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /vincular ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "vincular") {
    const nick = interaction.options.getString("nick").trim();
    const userId = interaction.user.id;

    // Verificar si ese nick ya está vinculado a otro usuario
    for (const [n, id] of vinculaciones.entries()) {
      if (n.toLowerCase() === nick.toLowerCase() && id !== userId) {
        return interaction.reply({
          content: `❌ El nick **${nick}** ya está vinculado a otra cuenta de Discord.`,
          flags: 64,
        });
      }
    }

    vinculaciones.set(nick.toLowerCase(), userId);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle("✅ Cuenta vinculada")
          .setDescription(`Tu nick de Minecraft **${nick}** ha sido vinculado a tu cuenta de Discord correctamente.`)
          .addFields({ name: "⛏️ Minecraft", value: nick, inline: true },
                     { name: "💬 Discord",   value: interaction.user.username, inline: true })
          .setTimestamp()
      ],
      flags: 64,
    });
  }

  // ── /desvincular ───────────────────────────────────────────────────────────
  if (interaction.commandName === "desvincular") {
    const userId = interaction.user.id;
    let encontrado = null;

    for (const [nick, id] of vinculaciones.entries()) {
      if (id === userId) { encontrado = nick; break; }
    }

    if (!encontrado) {
      return interaction.reply({
        content: "❌ No tenés ninguna cuenta de Minecraft vinculada.",
        flags: 64,
      });
    }

    vinculaciones.delete(encontrado);

    return interaction.reply({
      content: `✅ Tu nick de Minecraft **${encontrado}** fue desvinculado correctamente.`,
      flags: 64,
    });
  }

  // ── /vinculaciones ─────────────────────────────────────────────────────────
  if (interaction.commandName === "vinculaciones") {
    if (!tienePermiso(interaction.member)) {
      return interaction.reply({
        content: "❌ No tenés permisos para usar este comando.",
        flags: 64,
      });
    }

    if (vinculaciones.size === 0) {
      return interaction.reply({
        content: "📭 No hay vinculaciones registradas todavía.",
        flags: 64,
      });
    }

    const lista = [];
    for (const [nick, userId] of vinculaciones.entries()) {
      lista.push(`⛏️ **${nick}** → <@${userId}>`);
    }

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📋 Vinculaciones Minecraft ↔ Discord")
          .setDescription(lista.join("\n"))
          .setFooter({ text: `Total: ${vinculaciones.size} vinculaciones` })
          .setTimestamp()
      ],
      flags: 64,
    });
  }

  // ── /notificar ─────────────────────────────────────────────────────────────
  if (interaction.commandName === "notificar") {
    if (!tienePermiso(interaction.member)) {
      return interaction.reply({
        content: "❌ No tenés permisos para usar este comando. Necesitás ser Administrador o tener un rol de Staff autorizado.",
        flags: 64,
      });
    }

    await interaction.deferReply({ flags: 64 });

    const nickMinecraft = interaction.options.getString("nick_minecraft").trim();
    const motivo        = interaction.options.getString("motivo");
    const tipo          = interaction.options.getString("tipo");
    const duracion      = interaction.options.getString("duracion");
    const staff         = interaction.user;
    const guild         = interaction.guild;

    // Buscar el usuario vinculado
    const userId = vinculaciones.get(nickMinecraft.toLowerCase());

    if (!userId) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle("❌ Usuario no encontrado")
            .setDescription(`El nick **${nickMinecraft}** no tiene ninguna cuenta de Discord vinculada.`)
            .addFields({
              name: "¿Qué puede hacer el jugador?",
              value: "El jugador debe usar `/vincular " + nickMinecraft + "` en el servidor de Discord para vincular su cuenta.",
            })
            .setTimestamp()
        ],
      });
    }

    let usuarioTarget;
    try {
      usuarioTarget = await client.users.fetch(userId);
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
                  { name: "⛏️ Nick Minecraft", value: nickMinecraft, inline: true },
                  { name: "👤 Discord", value: `${usuarioTarget.username} (<@${userId}>)`, inline: true },
                  { name: "👮 Staff", value: `${staff.username} (<@${staff.id}>)`, inline: true },
                  { name: "📋 Tipo", value: sancionInfo.label, inline: true },
                  ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
                  { name: "📝 Motivo", value: motivo, inline: false },
                  { name: "📨 DM Enviado", value: dmEnviado ? "✅ Sí" : "❌ No (DMs cerrados)", inline: true }
                )
                .setTimestamp()
                .setFooter({ text: `ID: ${userId}` })
            ],
          });
        }
      } catch (err) {
        console.error("Error al enviar log:", err);
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
              ? `La notificación fue enviada exitosamente a **${usuarioTarget.username}** (${nickMinecraft}) por MD.`
              : `**${usuarioTarget.username}** tiene los DMs cerrados. La sanción fue registrada pero no pudo notificarse.`
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
});

// ─── Errores ───────────────────────────────────────────────────────────────────

client.on("error", (error) => console.error("❌ Error del cliente:", error));
process.on("unhandledRejection", (error) => console.error("❌ Promesa rechazada:", error));

// ─── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.TOKEN);
