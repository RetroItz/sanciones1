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

const ROLES_PERMITIDOS = [];
const CANAL_LOGS_ID = null;

const commands = [
  new SlashCommandBuilder()
    .setName("notificar")
    .setDescription("Notifica a un usuario que ha recibido una sanción")
    .addUserOption((o) =>
      o.setName("usuario").setDescription("El usuario a sancionar").setRequired(true)
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
});

const TIPOS_SANCION = {
  advertencia: { label: "⚠️ Advertencia",       color: 0xf59e0b, emoji: "⚠️" },
  mute:        { label: "🔇 Silenciado (Mute)",  color: 0x6366f1, emoji: "🔇" },
  kick:        { label: "🦶 Expulsión (Kick)",   color: 0xf97316, emoji: "🦶" },
  ban_temp:    { label: "🔨 Baneo Temporal",     color: 0xef4444, emoji: "🔨" },
  ban_perm:    { label: "⛔ Baneo Permanente",   color: 0x991b1b, emoji: "⛔" },
  jail:        { label: "🔒 Jail",               color: 0x78716c, emoji: "🔒" },
};

function tienePermiso(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (ROLES_PERMITIDOS.length === 0) return false;
  return ROLES_PERMITIDOS.some((roleId) => member.roles.cache.has(roleId));
}

function crearEmbedSancion({ usuario, tipo, motivo, duracion, staff, guild }) {
  const sancion = TIPOS_SANCION[tipo];
  const ahora = new Date();

  return new EmbedBuilder()
    .setTitle(`${sancion.emoji} Has recibido una sanción`)
    .setColor(sancion.color)
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription(
      `Hola **${usuario.username}**, el equipo de staff del servidor **${guild.name}** te informa que has recibido la siguiente sanción:`
    )
    .addFields(
      { name: "📋 Tipo de Sanción", value: sancion.label, inline: true },
      { name: "📅 Fecha", value: `<t:${Math.floor(ahora.getTime() / 1000)}:F>`, inline: true },
      ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
      { name: "📝 Motivo", value: motivo, inline: false },
      { name: "👮 Staff Responsable", value: `${staff.username}`, inline: false },
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

function crearEmbedLog({ usuario, tipo, motivo, duracion, staff, dmEnviado }) {
  const sancion = TIPOS_SANCION[tipo];

  return new EmbedBuilder()
    .setTitle(`📋 Log de Sanción — ${sancion.label}`)
    .setColor(sancion.color)
    .addFields(
      { name: "👤 Usuario Sancionado", value: `${usuario.username} (<@${usuario.id}>)`, inline: true },
      { name: "👮 Staff", value: `${staff.username} (<@${staff.id}>)`, inline: true },
      { name: "📋 Tipo", value: sancion.label, inline: true },
      ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
      { name: "📝 Motivo", value: motivo, inline: false },
      { name: "📨 DM Enviado", value: dmEnviado ? "✅ Sí" : "❌ No (DMs cerrados)", inline: true }
    )
    .setTimestamp()
    .setFooter({ text: `ID Usuario: ${usuario.id}` });
}

client.once("ready", async () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  console.log(`📡 Servidores: ${client.guilds.cache.size}`);
  client.user.setActivity("⚖️ Gestionando sanciones", { type: 3 });
  await registrarComandos();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "notificar") return;

  if (!tienePermiso(interaction.member)) {
    return interaction.reply({
      content: "❌ No tenés permisos para usar este comando. Necesitás ser Administrador o tener un rol de Staff autorizado.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const usuarioTarget = interaction.options.getUser("usuario");
  const motivo       = interaction.options.getString("motivo");
  const tipo         = interaction.options.getString("tipo");
  const duracion     = interaction.options.getString("duracion");
  const staff        = interaction.user;
  const guild        = interaction.guild;

  if (usuarioTarget.id === staff.id)
    return interaction.editReply({ content: "❌ No podés sancionarte a vos mismo." });

  if (usuarioTarget.bot)
    return interaction.editReply({ content: "❌ No podés sancionar a bots." });

  const embedSancion = crearEmbedSancion({ usuario: usuarioTarget, tipo, motivo, duracion, staff, guild });

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
      if (canalLogs)
        await canalLogs.send({ embeds: [crearEmbedLog({ usuario: usuarioTarget, tipo, motivo, duracion, staff, dmEnviado })] });
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
            ? `La notificación fue enviada exitosamente a **${usuarioTarget.username}** por MD.`
            : `**${usuarioTarget.username}** tiene los DMs cerrados. La sanción fue registrada pero no pudo notificarse.`
        )
        .addFields(
          { name: "Usuario", value: `<@${usuarioTarget.id}>`, inline: true },
          { name: "Tipo", value: sancion.label, inline: true },
          { name: "Motivo", value: motivo, inline: false }
        )
        .setTimestamp()
    ],
  });
});

client.on("error", (error) => console.error("❌ Error del cliente:", error));
process.on("unhandledRejection", (error) => console.error("❌ Promesa rechazada:", error));

client.login(process.env.TOKEN);
