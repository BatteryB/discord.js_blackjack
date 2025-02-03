// TODO //
// 모든 유저가 카드를 받지 않는 상태가 되었기에 게임을 종료합니다. 까지만 만듦
// 스플릿, 더블다운 만들기

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Embed, EmbedBuilder, Events, GatewayIntentBits } from 'discord.js';
import env from 'dotenv';
import sqlite from 'sqlite3';

const gameData = new sqlite.Database('db/game.db');
const userData = new sqlite.Database('db/user.db');
await userData.run(`UPDATE user SET joined = 0`);

env.config({ path: 'env/discord.env' })

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.ClientReady, readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}!`);
});

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.commandName === '가입') {
        await interaction.deferReply({ flags: 64 })
        if (await joinCheck(interaction.user.id)) { return await interaction.editReply('이미 가입하셨습니다.'); }
        await userData.run(`INSERT INTO user(id) VALUES(?)`, [interaction.user.id]);
        return await interaction.editReply('가입이 완료되었습니다!\n(기본지급 +500점)')
    }

    if (!await joinCheck(interaction.user.id)) return await interaction.reply({ content: '먼저 가입을 해주세요!', flags: 64 })

    if (interaction.commandName === '게임방생성') {
        if (await gameCheck(interaction.user.id)) return await interaction.reply({ content: '이미 참여중인 게임이 있습니다.', flags: 64 })
        await userData.run(`UPDATE user SET joined = 1 WHERE id = ?`, [interaction.user.id]);
        await interaction.deferReply();

        let userList = [interaction.user.id];
        const game = interaction.options.getString('게임');
        const gameInfo = await getGameInfo(game);

        const embedTitle = `${interaction.user.globalName}의 ${gameInfo.name}방`;
        let gameEmbed = createEmbed(embedTitle, `참가자: <@${interaction.user.id}>(방장)`)
        let response = await interaction.editReply({
            embeds: [gameEmbed],
            components: [roomRow]
        })

        const collector = response.createMessageComponentCollector({ time: 180_000 });

        collector.on('end', async (reason) => {
            if (reason == 'time') {
                return await interaction.editReply({
                    content: '시간이 초과되어 방 생성이 취소되었습니다.',
                    components: []
                });
            };
        });

        collector.on('collect', async i => { ///////////  참여 로비  //////////
            if (!await joinCheck(i.user.id)) return await i.reply({ content: `먼저 가입을 해주세요.`, flags: 64 }) // 가입 컷

            if (i.customId == 'join') { // 참가로직
                if (await gameCheck(i.user.id)) return await i.reply({ content: '이미 참여중인 게임이 있습니다.', flags: 64 }) // 참여중인 다른 게임
                if (userList.indexOf(String(i.user.id)) >= 0) return await i.reply({ content: '이미 참여한 게임입니다.', flags: 64 }) // 해당 게임 참여중
                if (userList.length >= gameInfo.max) return await i.reply({ content: '방이 다 찼습니다.', flags: 64 }) // 풀방

                await userData.run(`UPDATE user SET joined = 1 WHERE id = ?`, [i.user.id]);
                userList.push(i.user.id);
                i.reply({ content: `게임에 참가하셨습니다.`, flags: 64 });
            }

            if (i.customId == 'exit') { // 퇴장로직
                if (!await gameCheck(i.user.id)) return await i.reply({ content: '현재 참여중인 게임이 없습니다.', flags: 64 }) // 아무게임에 참여하지 않음
                if (userList.indexOf(String(i.user.id)) == -1) return await i.reply({ content: '해당 게임에 참여하지 않았습니다.', flags: 64 }) // 다른 게임에 참여중

                await userData.run(`UPDATE user SET joined = 0 WHERE id = ?`, [i.user.id]);
                userList.splice(userList.indexOf(i.user.id), 1);
                i.reply({ content: `참여중인 게임에서 퇴장하셨습니다.`, flags: 64 });
            }

            // 참가 or 퇴장 이후 유저수에 따라 게임방 제거 로직
            if (userList.length == 0) {
                gameEmbed = createEmbed(embedTitle, '참가자가 모두 게임방을 떠나 게임이 취소되었습니다.')
                await interaction.editReply({
                    embeds: [gameEmbed],
                    components: []
                });
                return collector.stop();
            }

            // 참가 or 퇴장 이후 게임방 텍스트 수정 로직
            gameEmbed = createEmbed(embedTitle, '참가자: ' + userList.map((user, index) => `<@${user}>${index == 0 ? '(방장)' : ''}`).join(' '));
            await interaction.editReply({ embeds: [gameEmbed] });

            if (i.customId == 'start') {
                if (i.user.id != userList[0]) return i.reply({ content: '방장만 선택 가능한 메뉴입니다.', flags: 64 }); // 방장 컷
                if (userList.length < gameInfo.min) return i.reply({ content: `${gameInfo.name}의 게임 플레이 최소 인원은 ${gameInfo.min}명 입니다.`, flags: 64 }); // 최소인원 컷

                collector.stop();
                gameEmbed = createEmbed(embedTitle + '의 게임이 시작되었습니다.', '참가자: ' + userList.map((user, index) => `<@${user}>${index == 0 ? '(방장)' : ''}`).join(' '))
                await interaction.editReply({
                    embeds: [gameEmbed],
                    components: []
                });

                const roomid = await new Promise((res, rej) => {
                    gameData.get(`SELECT id FROM room ORDER BY id DESC LIMIT 1`, (err, row) => res(++row.id))
                });

                await gameData.run(`INSERT INTO room VALUES(?, ?, ?)`, [roomid, gameInfo.name, userList.join(', ')]);

                // 여기부터
                const thread = await interaction.channel.threads.create({ // 스레드 만들기
                    name: `${interaction.user.globalName}님의 ${gameInfo.name} 게임방`,
                    autoArchiveDuration: 1440, // 최소 1일 유지
                    type: ChannelType.PrivateThread, // 비공개 스레드
                });

                userList.forEach(async user => { // 스레드에 유저 초대하기
                    await thread.members.add(user);
                });

                return await thread.send({
                    content: `모든 인원이 준비되었으면 시작 버튼을 눌러주세요!`,
                    components: [
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`${gameInfo.name}::${roomid}`)
                                    .setLabel('시작')
                                    .setStyle(ButtonStyle.Success)
                            )
                    ]
                });
            }
        });
    }

    if (interaction.isButton()) { //////// 게임 시작 ////////
        const game = interaction.customId.split('::'); // game[0] = 게임 이름, game[1] = 방 아이디

        if (game[0] == '블랙잭') {
            // await delMsg(interaction.channel);
            await interaction.reply({ content: '잠시 뒤 게임이 시작됩니다!' });
            const deck = deckDefined(); // 덱 불러오기
            const players = await getPlayer(game[1]);

            const playerScore = []; // 유저 점수 불러오기
            players.forEach(async player => {
                playerScore.push((await getUserInfo(player)).score);
            })

            let dealer = [];
            let playerDeck = {};
            players.forEach((p, index) => {
                playerDeck[index] = {
                    status: 'hit',
                    deck1: [],
                    deck2: [],
                };
            });

            let card1, card2
            card1 = Math.floor(Math.random() * deck.length);
            do { // card1과 겹치지 않게 랜덤값 뽑기
                card2 = Math.floor(Math.random() * deck.length);
            } while (card2 === card1);
            dealer.push(deck.splice(card1, 1)[0]); // 배열에 넣으면서 해당 값은 덱에서 제거하기
            dealer.push(deck.splice(card2, 1)[0]);

            players.forEach((p, index) => { // 딜러랑 똑같은 로직 ( 딜러에서 플레이어로 바뀜 )
                const key = Object.keys(playerDeck)[index];
                card1 = Math.floor(Math.random() * deck.length);
                do {
                    card2 = Math.floor(Math.random() * deck.length);
                } while (card2 == card1);
                playerDeck[key].deck1.push(deck.splice(card1, 1)[0]);
                playerDeck[key].deck1.push(deck.splice(card2, 1)[0]);
            })

            let turn = 0;
            let user = await client.users.fetch(players[turn]);
            let gameEmbed = new EmbedBuilder()
                .setTitle(`${user.displayName}의 턴`)
                .addFields({ name: '딜러', value: `${dealer[0].label}, ? ) (?)` })
                .setColor('#a469bb');

            for (const [index, p] of players.entries()) { // 임베드 필드 생성
                user = await client.users.fetch(players[index]);
                const key = Object.keys(playerDeck)[index];
                gameEmbed.addFields({ name: `${user.displayName}`, value: `${playerDeck[key].deck1.map(card => card.label).join(', ')} (${playerDeck[key].deck1.reduce((sum, card) => sum + card.value, 0)})` });
            }

            let response = await interaction.channel.send({
                embeds: [gameEmbed],
                components: [blackjackRow]
            })
            const collector = response.createMessageComponentCollector({ time: 0 });
            collector.on('collect', async i => {
                if (i.user.id != players[turn]) return await i.reply({ content: `당신의 턴이 아닙니다.`, flags: 64 })
                gameEmbed = new EmbedBuilder().setColor('#a469bb');
                gameEmbed.addFields({ name: '딜러', value: `${dealer[0].label}, ? (?)` });

                // let card = Math.floor(Math.random() * deck.length); 
                // dealer.push(deck.splice(card1, 1)[0]);

                let key = Object.keys(playerDeck)[turn]; // 해당 턴 유저 값 불러오기

                if (i.customId == 'hit') { // 히트
                    card = Math.floor(Math.random() * deck.length);
                    playerDeck[key].deck1.push(deck.splice(card1, 1)[0]); // 랜덤 카드 값 배열에 넣고 해당 값은 덱에서 제거
                }

                if (i.customId == 'stand') { // 스탠드
                    playerDeck[key].status = 'stand'; // 유저 상태를 stand로 변경
                }
                


                // 상호작용 이후 무조건 실행할 코드
                for (const [index, p] of players.entries()) { // 위 로직이랑 비슷함 유저 상태 표시
                    user = await client.users.fetch(players[index]); // 유저의 디스코드 정보 가져오기
                    const key = Object.keys(playerDeck)[index];
                    const total = playerDeck[key].deck1.reduce((sum, card) => sum + card.value, 0); // 유저 카드값 총 합
                    gameEmbed.addFields({ name: `${user.displayName}`, value: `${playerDeck[key].deck1.map(card => card.label).join(', ')} (${total}${total > 21 ? ' 버스트' : total == 21 ? ' 블랙잭' : playerDeck[key].status == 'stand' ? ' 스탠드' : ''})` }); // 삼항연산자 보이는 그대로 표시
                    if (total >= 21) playerDeck[key].status = 'stand'; // 유저의 카드값 총 합이 21과 같거나 크면 상태 stand로 변경
                }

                players.length - 1 == turn ? turn = 0 : turn++; // 턴 넘기기(마지막 유저면 처음유저로 돌아가는 삼항연산자)
                key = Object.keys(playerDeck)[turn]; // 다음 턴 유저 객체
                if (playerDeck[key].status == 'stand') { // 다음 턴 유저가 stand 상태면 턴 넘기기
                    players.length - 1 == turn ? turn = 0 : turn++;
                }

                user = await client.users.fetch(players[turn]);
                gameEmbed.setTitle(`${user.displayName}의 턴`);

                await response.edit({ embeds: [gameEmbed] });
                await i.reply({ content: `턴이 옮겨갔습니다.`, flags: 64 })

                if (Object.values(playerDeck).every(user => user.status == 'stand')) { // 모든 유저가 stand 상태면 게임 종료
                    console.log('모든 유저가 카드를 받지 않는 상태가 되었기에 게임을 종료합니다.');
                    return collector.stop();
                }
                return;
            })
        }
    }
});

async function joinCheck(id) {
    return await new Promise((res, rej) => {
        userData.get(`SELECT * FROM user WHERE id = ?`, [id], (err, row) => res(!!row));
    })
}

async function getUserInfo(id) {
    return await new Promise((res, rej) => {
        userData.get(`SELECT * FROM user WHERE id = ?`, [id], (err, row) => res(row));
    })
}

async function gameCheck(id) {
    return await new Promise((res, rej) => {
        userData.get(`SELECT * FROM user WHERE id = ?`, [id], (err, row) => res(Number(row.joined)));
    })
}

async function getGameInfo(name) {
    return await new Promise((res, rej) => {
        gameData.get(`SELECT * FROM game WHERE name = ?`, [name], (err, row) => res(row));
    })
}

async function getPlayer(roomid) {
    return await new Promise((res, rej) => {
        gameData.get(`SELECT player FROM room WHERE id = ?`, [roomid], (err, row) => res(row.player.split(', ')));
    })
}

function createEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor('#a469bb')
        .setTimestamp();
}

async function delMsg(chan) {
    const msg = await chan.messages.fetch({ limit: 100 });
    await chan.bulkDelete(msg);
}

function deckDefined() {
    const shape = ['♣', '♦', '♥', '♠'];
    const value = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const valueMap = {
        'A': 1,
        '2': 2,
        '3': 3,
        '4': 4,
        '5': 5,
        '6': 6,
        '7': 7,
        '8': 8,
        '9': 9,
        '10': 10,
        'J': 10,
        'Q': 10,
        'K': 10
    };

    const deck = [];
    shape.forEach(shape => {
        value.forEach(value => {
            deck.push({
                label: `${value}${shape}`,
                value: valueMap[value]
            })
        })
    })
    return deck;
}

const roomRow = new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('start')
            .setLabel('게임시작')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('join')
            .setLabel('참가')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('exit')
            .setLabel('나가기')
            .setStyle(ButtonStyle.Danger)
    )

const blackjackRow = new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('hit')
            .setLabel('히트')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('stand')
            .setLabel('스탠드')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('doubleDown')
            .setLabel('더블다운')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('split')
            .setLabel('스플릿')
            .setStyle(ButtonStyle.Success)
    )

client.login(process.env.TOKEN);
