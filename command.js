import { REST, Routes } from 'discord.js';
import sqlite from 'sqlite3';
import env from 'dotenv';

env.config({ path: 'env/discord.env' })
const gameData = new sqlite.Database('db/game.db');

const game = await new Promise((res, rej) => {
    gameData.all(`SELECT * FROM game`, (err, row) => res(row));
});

const gameList = [];
game.forEach(game => {
    gameList.push({
        name: game.name,
        value: game.name
    });
})

const commands = [
    {
        name: '가입',
        description: '게임에 가입합니다.'
    },
    {
        name: '게임방생성',
        description: '게임방을 생성합니다.',
        options: [
            {
                name: '게임',
                description: '플레이 할 게임을 선택하세요.',
                type: 3,
                required: true,
                choices: gameList
            },
        ]
    },
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });

    console.log('Successfully reloaded application (/) commands.');
} catch (error) {
    console.error(error);
}
