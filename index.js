require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    Colors,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const schedule = require('node-schedule');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

const config = require('./config.json');

// リマインダーを保存
const reminders = {};

// 確認待ちメッセージを保存
const awaitingConfirmation = {};

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const reminderCommand = new SlashCommandBuilder()
        .setName('remind')
        .setDescription('リマインダーを設定します。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('新しいリマインダーを追加します。')
                .addStringOption(option =>
                    option.setName('time')
                        .setDescription('リマインドする時間 (例: 10s, 5m, 2h, 1d, 2024/01/01 12:00)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('リマインドするメッセージ')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('設定済みのリマインダー一覧を表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('リマインダーを削除します。')
                .addIntegerOption(option =>
                    option.setName('id')
                        .setDescription('削除するリマインダーのID')
                        .setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

    const guildId = process.env.GUILD_ID;
    if (guildId) {
        client.application.commands.create(reminderCommand, guildId);
    } else {
        client.application.commands.create(reminderCommand);
    }

    loadReminders();
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'remind') {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'add') {
            await handleAddReminder(interaction);
        } else if (subcommand === 'list') {
            await handleListReminders(interaction);
        } else if (subcommand === 'delete') {
            await handleDeleteReminder(interaction);
        }
    } else if (interaction.isButton() && interaction.customId.startsWith('confirm_reminder_')) {
        await handleConfirmReminder(interaction);
    }
});


async function handleAddReminder(interaction) {
    const timeString = interaction.options.getString('time');
    const message = interaction.options.getString('message');
    const userId = interaction.user.id;

    const reminderTime = parseTimeString(timeString);
    if (!reminderTime || reminderTime.getTime() <= Date.now()) {
        await interaction.reply({ content: '有効な未来の時間を指定してください (例: 10s, 5m, 2h, 1d, 2024/01/01 12:00)。', ephemeral: true });
        return;
    }

    const reminderId = Date.now();

    reminders[reminderId] = {
        userId,
        time: reminderTime,
        message,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        retries: 0       // 再送回数 (最初は0)
    };
    saveReminders();

    // 初回のリマインドをスケジュール
    scheduleReminder(reminderId);


    const embed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle('リマインダー設定')
        .setDescription(`リマインダーを設定しました。\nID: ${reminderId}\n日時: ${reminderTime.toLocaleString()}\nメッセージ: ${message}`)
        .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
}


async function handleListReminders(interaction) {
    const userId = interaction.user.id;
    const userReminders = Object.entries(reminders)
        .filter(([id, reminder]) => reminder.userId === userId)
        .map(([id, reminder]) => ({ id, ...reminder }));

    if (userReminders.length === 0) {
        await interaction.reply({ content: '設定されているリマインダーはありません。', ephemeral: true });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle('リマインダー一覧')
        //  再送回数も表示
        .setDescription(userReminders.map(r => `ID: ${r.id} - ${r.time.toLocaleString()} - ${r.message} - 再送: ${r.retries}`).join('\n'))
        .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleDeleteReminder(interaction) {
    const reminderId = interaction.options.getInteger('id');
    const reminder = reminders[reminderId];

    if (!reminder) {
        await interaction.reply({ content: '指定されたIDのリマインダーは見つかりませんでした。', ephemeral: true });
        return;
    }

      if (awaitingConfirmation[reminderId]) {
          delete awaitingConfirmation[reminderId];
      }

      if(reminders[reminderId]){
        const job = schedule.scheduledJobs[reminderId];
        if(job) job.cancel();
        delete reminders[reminderId];
        saveReminders();
      }

    const embed = new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle('リマインダー削除')
        .setDescription(`リマインダー (ID: ${reminderId}) を削除しました。`)
        .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
}



async function sendReminderWithConfirmation(userId, message, reminderId, channel, retries = 0) {
    const confirmButton = new ButtonBuilder()
        .setCustomId(`confirm_reminder_${reminderId}`)
        .setLabel('確認')
        .setStyle(ButtonStyle.Primary);

    const actionRow = new ActionRowBuilder().addComponents(confirmButton);

    const embed = new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle('リマインダー')
        .setDescription(`${message}\n確認ボタンを押してください。`)
        .addFields({ name: '設定ID', value: reminderId.toString() },
                   {name: "再送回数", value: retries.toString()}) // 再送回数表示
        .setTimestamp();

    try {
        const sentMessage = await channel.send({
            content: `<@${userId}>`,
            embeds: [embed],
            components: [actionRow]
        });

        awaitingConfirmation[reminderId] = {
            userId,
            message,
            channelId: channel.id,
            messageId: sentMessage.id,
            retries: retries
        };

    } catch (error) {
        console.error('Error sending reminder:', error);
    }
}



async function handleConfirmReminder(interaction) {
  const reminderId = interaction.customId.split('_')[2];

  if (awaitingConfirmation[reminderId]) {
    delete awaitingConfirmation[reminderId];

    if (reminders[reminderId]) {
      delete reminders[reminderId];
      saveReminders();
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle('リマインダー確認')
      .setDescription('リマインダーを確認しました。')
      .setTimestamp();
    await interaction.update({ embeds: [embed], components: [] });

  }  else {
    await interaction.reply({ content: 'このリマインダーはすでに確認済み、または削除されています。', ephemeral: true });
  }
}


function scheduleReminder(reminderId) {
    const reminder = reminders[reminderId];
    if (!reminder) return; // リマインダーが存在しない場合は何もしない

    const job = schedule.scheduleJob(reminder.time, () => {
        sendReminderWithConfirmation(reminder.userId, reminder.message, reminderId, client.channels.cache.get(reminder.channelId));
    });
      schedule.scheduledJobs[reminderId] = job;
}


function scheduleRetry(reminderId) {
    const retryInterval = config.retryIntervalMinutes * 60 * 1000;

    const job = setTimeout(async () => {
        if (awaitingConfirmation[reminderId] && reminders[reminderId]) {
            const { userId, message, channelId, messageId, retries } = awaitingConfirmation[reminderId];
            const channel = client.channels.cache.get(channelId);

            if (channel) {
                try {
                    const oldMessage = await channel.messages.fetch(messageId);
                    if (oldMessage) await oldMessage.delete();
                } catch (error) {
                    console.error("Failed to delete old message:", error);
                }

                // 最大再送回数チェック
                if (retries + 1 > config.maxRetries) {
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor(Colors.Red)
                        .setTitle('リマインダー')
                        .setDescription(`確認が行われなかったため、リマインダーの再送を停止します。`)
                        .setTimestamp();
                    channel.send({ embeds: [timeoutEmbed] });

                    delete awaitingConfirmation[reminderId];
                    if(reminders[reminderId]){
                      delete reminders[reminderId];
                      saveReminders();
                    }

                    return;
                }

                reminders[reminderId].retries = retries + 1;
                saveReminders();
                sendReminderWithConfirmation(userId, message, reminderId, channel, retries + 1);

            } else {
                delete awaitingConfirmation[reminderId];
                if(reminders[reminderId]){
                  delete reminders[reminderId];
                  saveReminders();
                }
            }
        }
    }, retryInterval);
    schedule.scheduledJobs[reminderId] = job;
}




function parseTimeString(timeString) {
    const now = new Date();
    const dateTimeMatch = timeString.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s(\d{1,2}):(\d{1,2})$/);
    if (dateTimeMatch) {
        const [, year, month, day, hour, minute] = dateTimeMatch;
        return new Date(year, month - 1, day, hour, minute);
    }
    const match = timeString.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
        case 's': return new Date(now.getTime() + value * 1000);
        case 'm': return new Date(now.getTime() + value * 60 * 1000);
        case 'h': return new Date(now.getTime() + value * 60 * 60 * 1000);
        case 'd': return new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
        default: return null;
    }
}

function saveReminders() {
    const fs = require('fs');
    const saveData = {};
    for (const [id, reminder] of Object.entries(reminders)) {
      const { job, ...reminderData } = reminder;
      saveData[id] = reminderData;
    }

    fs.writeFileSync('./reminders.json', JSON.stringify(saveData, (key, value) => {
        if (value instanceof Date) return value.toISOString();
        return value;
    }, 2));
}

function loadReminders() {
    const fs = require('fs');
    try {
        const data = fs.readFileSync('./reminders.json', 'utf8');
        const loadedReminders = JSON.parse(data, (key, value) => {
            if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
                return new Date(value);
            }
            return value;
        });

        for (const [id, reminder] of Object.entries(loadedReminders)) {
            reminders[id] = reminder;

            const guild = client.guilds.cache.get(reminder.guildId);
            if (!guild) continue;
            const channel = guild.channels.cache.get(reminder.channelId);
            if (!channel) continue;

            const now = new Date();
            const reminderTime = new Date(reminder.time);

            // リマインダーの時刻が過去で、かつ確認待ちリストにない場合のみ再送処理
            if (reminderTime <= now && !awaitingConfirmation[id]) {
                sendReminderWithConfirmation(reminder.userId, reminder.message, id, channel, reminder.retries);
            } else if(reminderTime > now){
              // 未来のリマインダーの場合は、通常通りスケジュール
              scheduleReminder(id);
            }
        }
        console.log("Loaded reminders:", reminders);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Error loading reminders:', error);
        }
    }
}

client.login(process.env.TOKEN);