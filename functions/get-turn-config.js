exports.handler = async function (event, context) {
    // (process.env)
    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            username: process.env.TURN_USER,
            credential: process.env.TURN_PASS
        })
    };
};
