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

    response.data.pipe(ndjson.parse()).on("data", callback).on("error", console.error);
}

async function main() {
    console.log("Started lichess server");

    stream("/api/stream/event", event => {
        console.log(event);
        const f = ({
            challenge: () => {
                console.log("Accepting challenge from " + event.challenge.challenger.name);
                axios.post(`/api/challenge/${event.challenge.id}/accept`);
            },
            gameStart: async () => {
                console.log("Game started with " + event.game.opponent.username);
                const me = event.game.color[0];
                const engine = childProcess.spawn("main.exe", {
                    stdio: ["pipe", "pipe"],
                });

                stream(`/api/bot/game/stream/${event.game.gameId}`, gameState => {
                    console.log(gameState);

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

                    console.log(chess.ascii());

                    if (chess.turn() === me) {
                        engine.stdin.write("position fen " + chess.fen() + "\n");
                        engine.stdin.write("go 4\n");
                    }
                });

                for await (let line of chunksToLinesAsync(engine.stdout)) {
                    line = line.trim();
                    console.log("Engine: " + line);
                    if (line.startsWith("bestmove ")) {
                        const move = line.substring("bestmove ".length);
                        console.log("Sending move: " + move);
                        axios.post(`/api/bot/game/${event.game.gameId}/move/${move}`);
                    }
                }
            }
        })[event.type];

        if (f) f();
        else console.log("Unknown event: " + event.type);
    });
}

main();