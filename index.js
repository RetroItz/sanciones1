// index.js - Bot de Sanciones para Discord
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
} from "discord.js";
import dotenv from "dotenv";
dotenv.config();

// ─── Configuración ─────────────────────────────────────────────────────────────

// IDs de roles que tienen permiso para usar /notificar
// Dejá vacío [] para que solo admins puedan usarlo, o agregá IDs de roles de staff
const ROLES_PERMITIDOS = [
  // "123456789012345678",  // Ejemplo: ID del rol "Moderador"
  // "987654321098765432",  // Ejemplo: ID del rol "Admin"
];

// ID del canal donde se registrarán los logs de sanciones (opcional)
// Dejá en null para no registrar logs
const CANAL_LOGS_ID = null; // Ejemplo: "123456789012345678"

// ─── Cliente de Discord ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

const TIPOS_SANCION = {
  advertencia: {
    label: "⚠️ Advertencia",
    color: 0xf59e0b,
    emoji: "⚠️",
  },
  mute: {
    label: "🔇 Silenciado (Mute)",
    color: 0x6366f1,
    emoji: "🔇",
  },
  kick: {
    label: "🦶 Expulsión (Kick)",
    color: 0xf97316,
    emoji: "🦶",
  },
  ban_temp: {
    label: "🔨 Baneo Temporal",
    color: 0xef4444,
    emoji: "🔨",
  },
  ban_perm: {
    label: "⛔ Baneo Permanente",
    color: 0x991b1b,
    emoji: "⛔",
  },
};

function tienePermiso(member) {
  // Si es administrador, siempre tiene permiso
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  // Si no hay roles configurados, solo admins pueden usar el comando
  if (ROLES_PERMITIDOS.length === 0) return false;

  // Verificar si tiene alguno de los roles permitidos
  return ROLES_PERMITIDOS.some((roleId) => member.roles.cache.has(roleId));
}

function crearEmbedSancion({ usuario, tipo, motivo, duracion, staff, guild }) {
  const sancion = TIPOS_SANCION[tipo];
  const ahora = new Date();

  const embed = new EmbedBuilder()
    .setTitle(`${sancion.emoji} Has recibido una sanción`)
    .setColor(sancion.color)
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription(
      `Hola **${usuario.username}**, el equipo de staff del servidor **${guild.name}** te informa que has recibido la siguiente sanción:`
    )
    .addFields(
      {
        name: "📋 Tipo de Sanción",
        value: sancion.label,
        inline: true,
      },
      {
        name: "📅 Fecha",
        value: `<t:${Math.floor(ahora.getTime() / 1000)}:F>`,
        inline: true,
      },
      ...(duracion
        ? [
            {
              name: "⏳ Duración",
              value: duracion,
              inline: true,
            },
          ]
        : []),
      {
        name: "📝 Motivo",
        value: motivo,
        inline: false,
      },
      {
        name: "👮 Staff Responsable",
        value: `${staff.username} (${staff.tag ?? staff.username})`,
        inline: false,
      }
    )
    .addFields({
      name: "ℹ️ Información",
      value:
        "Si considerás que esta sanción es injusta, podés apelarla contactando al equipo de moderación del servidor.",
      inline: false,
    })
    .setFooter({
      text: `${guild.name} • Sistema de Sanciones`,
      iconURL: guild.iconURL({ dynamic: true }),
    })
    .setTimestamp(ahora);

  return embed;
}

function crearEmbedLog({
  usuario,
  tipo,
  motivo,
  duracion,
  staff,
  guild,
  dmEnviado,
}) {
  const sancion = TIPOS_SANCION[tipo];
  const ahora = new Date();

  return new EmbedBuilder()
    .setTitle(`📋 Log de Sanción — ${sancion.label}`)
    .setColor(sancion.color)
    .addFields(
      {
        name: "👤 Usuario Sancionado",
        value: `${usuario.username} (<@${usuario.id}>)`,
        inline: true,
      },
      {
        name: "👮 Staff",
        value: `${staff.username} (<@${staff.id}>)`,
        inline: true,
      },
      {
        name: "📋 Tipo",
        value: sancion.label,
        inline: true,
      },
      ...(duracion ? [{ name: "⏳ Duración", value: duracion, inline: true }] : []),
      {
        name: "📝 Motivo",
        value: motivo,
        inline: false,
      },
      {
        name: "📨 DM Enviado",
        value: dmEnviado ? "✅ Sí" : "❌ No (DMs cerrados)",
        inline: true,
      }
    )
    .setTimestamp(ahora)
    .setFooter({ text: `ID Usuario: ${usuario.id}` });
}

// ─── Eventos ───────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅ Bot conectado como: ${client.user.tag}`);
  console.log(`📡 Servidores: ${client.guilds.cache.size}`);
  client.user.setActivity("⚖️ Gestionando sanciones", { type: 3 });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "notificar") return;

  // Verificar permiso
  if (!tienePermiso(interaction.member)) {
    return interaction.reply({
      content:
        "❌ No tenés permisos para usar este comando. Necesitás ser Administrador o tener un rol de Staff autorizado.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const usuarioTarget = interaction.options.getUser("usuario");
  const motivo = interaction.options.getString("motivo");
  const tipo = interaction.options.getString("tipo");
  const duracion = interaction.options.getString("duracion");
  const staff = interaction.user;
  const guild = interaction.guild;

  // No permitir sancionarse a uno mismo
  if (usuarioTarget.id === staff.id) {
    return interaction.editReply({
      content: "❌ No podés sancionarte a vos mismo.",
    });
  }

  // No permitir sancionar a bots
  if (usuarioTarget.bot) {
    return interaction.editReply({
      content: "❌ No podés sancionar a bots.",
    });
  }

  // Crear embed de sanción para el usuario
  const embedSancion = crearEmbedSancion({
    usuario: usuarioTarget,
    tipo,
    motivo,
    duracion,
    staff,
    guild,
  });

  // Intentar enviar DM al usuario
  let dmEnviado = false;
  try {
    await usuarioTarget.send({ embeds: [embedSancion] });
    dmEnviado = true;
  } catch (err) {
    // El usuario tiene los DMs cerrados
    dmEnviado = false;
  }

  // Registrar en canal de logs (si está configurado)
  if (CANAL_LOGS_ID) {
    try {
      const canalLogs = await guild.channels.fetch(CANAL_LOGS_ID);
      if (canalLogs) {
        const embedLog = crearEmbedLog({
          usuario: usuarioTarget,
          tipo,
          motivo,
          duracion,
          staff,
          guild,
          dmEnviado,
        });
        await canalLogs.send({ embeds: [embedLog] });
      }
    } catch (err) {
      console.error("Error al enviar log:", err);
    }
  }

  const sancion = TIPOS_SANCION[tipo];

  // Respuesta al staff
  const respuestaEmbed = new EmbedBuilder()
    .setColor(dmEnviado ? Colors.Green : Colors.Orange)
    .setTitle(dmEnviado ? "✅ Sanción notificada" : "⚠️ Sanción registrada (sin DM)")
    .setDescription(
      dmEnviado
        ? `La notificación de sanción fue enviada exitosamente a **${usuarioTarget.username}** por MD.`
        : `**${usuarioTarget.username}** tiene los mensajes directos cerrados. La sanción fue registrada pero no pudo notificarse por MD.`
    )
    .addFields(
      { name: "Usuario", value: `<@${usuarioTarget.id}>`, inline: true },
      { name: "Tipo", value: sancion.label, inline: true },
      { name: "Motivo", value: motivo, inline: false }
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [respuestaEmbed] });
});

// ─── Manejo de errores ────────────────────────────────────────────────────────

client.on("error", (error) => {
  console.error("❌ Error del cliente:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Promesa rechazada sin manejar:", error);
});

// ─── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.TOKEN);
