require('dotenv').config();
const axios = require('axios').default;
const ndjson = require("ndjson");
const { Chess } = require('chess.js');
const childProcess = require('child_process');
const { chunksToLinesAsync } = require('@rauschma/stringio');

axios.defaults.baseURL = "https://lichess.org";
axios.defaults.headers.common['Authorization'] = `Bearer ${process.env.LICHESS_API_KEY}`;

async function stream(url, callback) {
    let response = await axios.get(url, {
        responseType: "stream",
    });

    return new Promise((resolve, reject) => {
        response.data.pipe(ndjson.parse())
            .on("data", callback)
            .on("end", resolve)
            .on("error", reject);
    });
}

async function main() {
    console.log("Started lichess server");

    while (true) {
        await stream("/api/stream/event", event => {
            console.log(event);
            const f = ({
                challenge: async () => {
                    console.log("Accepting challenge from " + event.challenge.challenger.name);
                    try {
                        await axios.post(`/api/challenge/${event.challenge.id}/accept`);
                    } catch (err) {
                        console.error(err);
                    }
                },
                gameStart: async () => {
                    console.log("Game started with " + event.game.opponent.username);
                    const me = event.game.color[0];
                    const engine = childProcess.spawn("Chess.exe", {
                        stdio: ["pipe", "pipe"],
                    });

                    stream(`/api/bot/game/stream/${event.game.gameId}`, gameState => {
                        console.debug(gameState);

                        gameState = gameState.state || gameState;
                        if (gameState.status !== "started") return;

                        const chess = new Chess();

                        const moves = gameState.moves;
                        if (moves) {
                            for (const move of moves.split(" ")) {
                                if (!chess.move(move, { sloppy: true })) {
                                    console.log("Unable to parse move: " + move);
                                }
                            }
                        }

                        if (chess.turn() === me) {
                            console.log("Asking engine for move...");
                            engine.stdin.write("position fen " + chess.fen() + "\n");
                            engine.stdin.write("go 3\n");
                        }
                    });

                    for await (let line of chunksToLinesAsync(engine.stdout)) {
                        line = line.trim();
                        console.log("Engine: " + line);
                        if (line.startsWith("bestmove ")) {
                            const move = line.substring("bestmove ".length);
                            console.log("Sending move: " + move);

                            try {
                                await axios.post(`/api/bot/game/${event.game.gameId}/move/${move}`);
                            } catch (err) {
                                console.error(err);
                            }
                        }
                    }
                }
            })[event.type];

            if (f) f();
            else console.log("Unknown event: " + event.type);
        });
    }
}

main();