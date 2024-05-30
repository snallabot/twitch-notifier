import Koa, { ParameterizedContext } from "koa"
import Router from "@koa/router"
import bodyParser from "@koa/bodyparser"
import { randomBytes, createHmac, timingSafeEqual } from "crypto"

const app = new Koa()
const router = new Router()


// Notification request headers
const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id'.toLowerCase()
const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp'.toLowerCase()
const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature'.toLowerCase()
const MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type'

const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

const HMAC_PREFIX = 'sha256=';

function getSecret() {
    if (!process.env.SECRET) {
        throw new Error("no secret defined!")
    }
    return process.env.SECRET;
}

function getHmacMessage(ctx: ParameterizedContext) {
    return (ctx.get(TWITCH_MESSAGE_ID) +
        ctx.get(TWITCH_MESSAGE_TIMESTAMP) +
        ctx.request.rawBody);
}


function getHmac(secret: string, message: string) {
    return createHmac('sha256', secret)
        .update(message)
        .digest('hex');
}

function verifyMessage(hmac: string, verifySignature: string) {
    return timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
}

type Subscription = { id: string, status: string, type: string, version: "1", condition: { broadcaster_user_id: string }, transport: { method: string, callback: string }, created_at: string, cost: number }
type Event = { id: string, broadcaster_user_id: string, broadcaster_user_login: string, broadcaster_user_name: string, type: string, started_at: string }
type StreamUpEvent = { subscription: Subscription, event: Event }

router.post("/events", async (ctx, next) => {
    const twitchEvent = ctx.request.body as StreamUpEvent
    ctx.status = 200
    await next()
    const twitchUser = twitchEvent.event.broadcaster_user_id

})


app.use(bodyParser({ enableTypes: ["json"], encoding: "utf-8" }))
    .use(async (ctx, next) => {
        const secret = getSecret()
        const message = getHmacMessage(ctx)
        const hmac = HMAC_PREFIX + getHmac(secret, message)
        if (verifyMessage(hmac, ctx.request.get(TWITCH_MESSAGE_SIGNATURE))) {
            await next()
        } else {
            console.log("signatures dont match")
            ctx.status = 403
        }
    })
    .use(async (ctx, next) => {
        if (ctx.request.get(MESSAGE_TYPE) === MESSAGE_TYPE_VERIFICATION) {
            ctx.set({ "Content-Type": "text/plain" })
            ctx.status = 200
            ctx.body = JSON.parse(ctx.request.rawBody).challenge
        } else {
            await next()
        }
    })
    .use(async (ctx, next) => {
        if (MESSAGE_TYPE_REVOCATION === ctx.request.get(MESSAGE_TYPE)) {
            ctx.status = 204
            console.log(ctx.request.rawBody)
        } else {
            try {
                await next()
            } catch (err: any) {
                console.error(err)
                ctx.status = 500;
                ctx.body = {
                    message: err.message
                };
            }

        }
    })
    .use(router.routes())
    .use(router.allowedMethods())

export default app
