// deploy-commands.js
// Ejecutá este archivo UNA SOLA VEZ para registrar los comandos slash en Discord
// Comando: node deploy-commands.js

import { REST, Routes, SlashCommandBuilder } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName("notificar")
    .setDescription("Notifica a un usuario que ha recibido una sanción")
    .addUserOption((option) =>
      option
        .setName("usuario")
        .setDescription("El usuario a sancionar")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("motivo")
        .setDescription("Motivo de la sanción")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("tipo")
        .setDescription("Tipo de sanción")
        .setRequired(true)
        .addChoices(
          { name: "⚠️ Advertencia", value: "advertencia" },
          { name: "🔇 Silenciado (Mute)", value: "mute" },
          { name: "🦶 Expulsión (Kick)", value: "kick" },
          { name: "🔨 Baneo Temporal", value: "ban_temp" },
          { name: "⛔ Baneo Permanente", value: "ban_perm" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("duracion")
        .setDescription("Duración de la sanción (solo si aplica, ej: 7 días)")
        .setRequired(false)
    )
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log("⏳ Registrando comandos slash...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("✅ ¡Comandos registrados exitosamente!");
  } catch (error) {
    console.error("❌ Error al registrar comandos:", error);
  }
})();
