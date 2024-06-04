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

const TwitchRequester = () => {
    let token = ""
    const refreshToken = async () => {
        const res = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: `client_id=${process.env.CLIENT_ID}&client_secret=${process.env.CLIENT_SECRET}&grant_type=client_credentials`
        })
        if (!res.ok) {
            const text = await res.text()
            throw new Error("could not refresh token: " + text)
        }
        const tokenResponse = await res.json()
        token = tokenResponse.access_token
    }
    return {
        requestTwitchApi: async function(fetcher: (token: string) => Promise<Response>): Promise<Response> {
            if (!token) {
                await refreshToken()
            }
            const res = await fetcher(token)
            if (res.status === 401) {
                await refreshToken()
            }
            return await fetcher(token)
        }
    }
}

const twitchCall = TwitchRequester()

type Subscription = { id: string, status: string, type: string, version: "1", condition: { broadcaster_user_id: string }, transport: { method: string, callback: string }, created_at: string, cost: number }
type Event = { id: string, broadcaster_user_id: string, broadcaster_user_login: string, broadcaster_user_name: string, type: string, started_at: string }
type StreamUpEvent = { subscription: Subscription, event: Event }

type BroadcasterInfo = { broadcaster_id: string, broadcaster_login: string, broadcaster_name: string, broadcaster_language: string, game_id: string, game_name: string, title: string, delay: number, tags: Array<string>, content_classification_labels: Array<string>, is_branded_content: boolean }
type TwitchChannelInformation = { data: Array<BroadcasterInfo> }

type UserInfo = { id: string, login: string, display_name: string, type: string, broadcaster_type: string, description: string, profile_image_url: string, offline_image_url: string, view_count: number, email: string, created_at: string }
type TwitchUserInformation = { data: Array<UserInfo> }

type SubscriptionInfo = { id: string, status: string, type: string, version: string, cost: number, condition: { broadcaster_user_id: string }, transpoter: { method: "webhook", callback: string }, created_at: string }
type TwitchSubscription = { data: Array<SubscriptionInfo>, total: number, total_cost: number, max_total_cost: number }

type ConfigureRequest = { discord_server: string, twitch_url: string, event_type: string }

router.post("/events", async (ctx, next) => {
    const twitchEvent = ctx.request.body as StreamUpEvent
    ctx.status = 200
    await next()
    const twitchUser = twitchEvent.event.broadcaster_user_id
    const res = await twitchCall.requestTwitchApi(async (token) =>
        await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${twitchUser}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Client-Id": `${process.env.CLIENT_ID}`
            }
        })
    )
    if (!res.ok) {
        const t = await res.text()
        throw new Error(`twitch call for ${twitchUser} failed ${t}`)
    }
    const twitchResponse = await res.json() as TwitchChannelInformation
    if (twitchResponse.data.length === 0) {
        throw new Error("no twitch channel information found")
    }
    const broadcaster = twitchResponse.data[0]
    const broadcastTitle = broadcaster.broadcaster_name
}).post("/configure", async (ctx, next) => {
    const request = ctx.request.body as ConfigureRequest
    const login = request.twitch_url.substring(request.twitch_url.lastIndexOf('/') + 1)
    const res = await twitchCall.requestTwitchApi(async (token) =>
        await fetch(`https://api.twitch.tv/helix/users?login=${login}}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Client-Id": `${process.env.CLIENT_ID}`
            }
        })
    )
    if (!res.ok) {
        const t = await res.text()
        throw new Error(`Could not find ${login} on Twitch! ` + t)
    }
    const twitchResponse = await res.json() as TwitchUserInformation
    if (twitchResponse.data.length === 0) {
        throw new Error(`Could not find information on ${login} on Twitch!`)
    }
    const user = twitchResponse.data[0]
    const broadcaster_id = user.id
    if (request.event_type === "ADD_CHANNEL") {
        // create subscription
        const res = await twitchCall.requestTwitchApi(async (token) =>
            await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Client-Id": `${process.env.CLIENT_ID}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    type: "stream.online",
                    version: "1",
                    condition: {
                        "broadcaster_user_id": broadcaster_id
                    },
                    transport: {
                        method: "webhook",
                        callback: "URL HERE",
                        secret: getSecret()
                    }
                })
            })
        )
        if (!res.ok) {
            const t = await res.text()
            throw new Error(`could not create twitch subscription for ${broadcaster_id}: ${t}`)
        }
        const subscription = await res.json() as TwitchSubscription
        await fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/post", {
            method: "POST",
            body: JSON.stringify({ key: "twitch_channels", event_type: request.event_type, delivery: "EVENT_SOURCE", channel_id: broadcaster_id, discord_server: request.discord_server }),
            headers: {
                "Content-Type": "application/json"
            }
        })
        await fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/post", {
            method: "POST",
            body: JSON.stringify({ key: broadcaster_id, event_type: "ADDED_TWITCH_CHANNEL", delivery: "EVENT_SOURCE", channel_id: broadcaster_id, discord_server: request.discord_server }),
            headers: {
                "Content-Type": "application/json"
            }
        })
    } else if (request.event_type === "REMOVE_CHANNEL") {
        // potentially delete subscription
        await fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/post", {
            method: "POST",
            body: JSON.stringify({ key: "twitch_channels", event_type: request.event_type, delivery: "EVENT_SOURCE", channel_id: broadcaster_id, discord_server: request.discord_server }),
            headers: {
                "Content-Type": "application/json"
            }
        })
    }
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
