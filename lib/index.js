"use strict";
(function discordio(Discord) {
var isNode = typeof(window) === "undefined" && typeof(navigator) === "undefined";
var CURRENT_VERSION = "2.x.x",
    GATEWAY_VERSION = 5,
    LARGE_THRESHOLD = 250,
    CONNECT_WHEN = null,
	Endpoints, Payloads,
	EventEmitter, Websocket;

if (isNode) {
	var FS          = require('fs'),
        UDP         = require('dgram'),
        Zlib        = require('zlib'),
        DNS         = require('dns'),
        Stream      = require('stream'),
        BN          = require('path').basename,
        requesters  = {
            http:     require('http'),
            https:    require('https')
        },
        ChildProc   = require('child_process'),
        URL         = require('url'),
        //NPM Modules
        NACL        = require('tweetnacl'),
		Opus        = null;

	EventEmitter = require('events').EventEmitter;
	Websocket    = require('ws');

} else {
	class EventEmitter {
		constructor() {
			this._evts = {};
		}
		on(eName, eFunc) {
			if (!this._evts[eName]) this._evts[eName] = [];
			this._evts[eName].push(eOn);

			return this.addEventListener(eName, e => {
				return eFunc.apply(null, resolveEvent(e));
			});
		}
		once(eName, eFunc) {
			if (!this._evts[eName]) this._evts[eName] = [];
			this._evts[eName].push(eOnce);

			return this.addEventListener(eName, e => {
				eFunc.apply(null, resolveEvent(e));
				return this.removeListener(eName, eOnce);
			});
		}
		removeListener(eName, eFunc) {
			if (this._evts[eName]) this._evts[eName].splice(this._evts[eName].lastIndexOf(eFunc), 1);
			return this.removeEventListener(eName, eFunc);
		}
		emit(eName) {
			return this.dispatchEvent( new CustomEvent(eName, {'detail': Array.prototype.slice.call(arguments, 1) }) );
		}
		static wrap(obj) {
			Object.keys(this.prototype).forEach(function(method) {
				if (typeof(this.prototype[method]) !== 'function') return;
				obj[method] = obj[method] || this.prototype[method].bind(obj);
			}, this);
		}
	}
	(function _Emitter(EE) {
		//Thank you, http://stackoverflow.com/a/24216547
		var eventTarget = document.createDocumentFragment();
		["addEventListener", "dispatchEvent", "removeEventListener"].forEach(function(method) {
			if (!EE[method]) EE[method] = eventTarget[method].bind(eventTarget);
		});
	})(EventEmitter.prototype);
	class Websocket extends WebSocket {
		constructor(url) {
			super(url);
			EventEmitter.wrap(this);
		}
	}
}

/* --- Version Check --- */
try {
	CURRENT_VERSION = require('../package.json').version;
} catch(e) {}
if (!isNode) CURRENT_VERSION += "-browser";

/**
 * Discord Client constructor
 * @class
 * @arg {Object} options
 * @arg {String} options.token - The token of the account you wish to log in with.
 * @arg {Boolean} [options.autorun] - If true, the client runs when constructed without calling `.connect()`.
 * @arg {Number} [options.messageCacheLimit] - The amount of messages to cache in memory, per channel. Used for information on deleted/updated messages. The default is 50.
 * @arg {Array<Number>} [options.shard] - The shard array. The first index is the current shard ID, the second is the amount of shards that should be running.
 */
class DiscordClient extends EventEmitter {
	constructor(options = {}) {
		super();

		if (!options || !(options instanceof Object)) return console.error("An Object is required to create the discord.io client.");

		applyProperties(this, [
			["_ws", null],
			["_uIDToDM", {}],
			["_ready", false],
			["_vChannels", {}],
			["_messageCache", {}],
			["_connecting", false],
			["_mainKeepAlive", null],
			["_req", APIRequest.bind(this)],
			["_shard", this.validateShard(options.shard)],
			["_messageCacheLimit", typeof(options.messageCacheLimit) === 'number' ? options.messageCacheLimit : 50],
		]);
	
		this.presenceStatus = "offline";
		this.connected = false;
		this.inviteURL = null;
		//this.connect = this.connect.bind(this, options);
	
		if (options.autorun === true) this.connect(options);
	}

	/* - DiscordClient - Methods - */

	/**
	 * Manually initiate the WebSocket connection to Discord.
	 */
	connect(opts) {
		if (!this.connected && !this._connecting) return setTimeout(function() {
			this.init(opts);
			CONNECT_WHEN = Math.max(CONNECT_WHEN, Date.now()) + 6000;
		}.bind(this), Math.max( 0, CONNECT_WHEN - Date.now() ));
	}

	/**
	 * Disconnect the WebSocket connection to Discord.
	 */
	disconnect() {
		if (this._ws) return this._ws.close(1000, "Manual disconnect"), log(this, "Manual disconnect called, websocket closed");
		return log(this, Discord.LogLevels.Warn, "Manual disconnect called with no WebSocket active, ignored");
	}

	/**
	 * Retrieve a user object from Discord, Bot only endpoint. You don't have to share a server with this user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.userID
	 */
	getUser(input, callback) {
		if (!this.bot) return handleErrCB("[getUser] This account is a 'user' type account, and cannot use 'getUser'. Only bots can use this endpoint.", callback);
		this._req('get', Endpoints.USER(input.userID), function(err, res) {
			handleResCB("Could not get user", err, res, callback);
		});
	}

	/**
	 * Edit the client's user information.
	 * @arg {Object} input
	 * @arg {String<Base64>} input.avatar - The last part of a Base64 Data URI. `fs.readFileSync('image.jpg', 'base64')` is enough.
	 * @arg {String} input.username - A username.
	 * @arg {String} input.email - [User only] An email.
	 * @arg {String} input.password - [User only] Your current password.
	 * @arg {String} input.new_password - [User only] A new password.
	 */
	editUserInfo(input, callback) {
		var payload = {
			avatar: this.avatar,
			email: this.email,
			new_password: null,
			password: null,
			username: this.username
		},
			plArr = Object.keys(payload);
	
		for (var key in input) {
			if (plArr.indexOf(key) < 0) return handleErrCB(("[editUserInfo] '" + key + "' is not a valid key. Valid keys are: " + plArr.join(", ")), callback);
			payload[key] = input[key];
		}
		if (input.avatar) payload.avatar = "data:image/jpg;base64," + input.avatar;
	
		this._req('patch', Endpoints.ME, payload, function(err, res) {
			handleResCB("Unable to edit user information", err, res, callback);
		});
	}

	/**
	 * Change the client's presence.
	 * @arg {Object} input
	 * @arg {String|null} input.status - Used to set the status. online, idle, dnd, invisible, and offline are the possible states.
	 * @arg {Number|null} input.since - Optional, use a Number before the current point in time.
	 * @arg {Boolean|null} input.afk - Optional, changes how Discord handles push notifications.
	 * @arg {Object|null} input.game - Used to set game information.
	 * @arg {String|null} input.game.name - The name of the game.
	 * @arg {Number|null} input.game.type - Activity type, 0 for game, 1 for Twitch.
	 * @arg {String|null} input.game.url - A URL matching the streaming service you've selected.
	 */
	setPresence(input) {
		var payload = Payloads.STATUS(input);
		send(this._ws, payload);

		this.presenceStatus = payload.d.status;
	}

	/**
	 * Receive OAuth information for the current client.
	 */
	getOauthInfo(callback) {
		this._req('get', Endpoints.OAUTH, (err, res) => {
			handleResCB("Error GETing OAuth information", err, res, callback);
		});
	}

	/**
	 * Receive account settings information for the current client.
	 */
	getAccountSettings(callback) {
		if (this.bot) {
			return void(handleErrCB("[getAccountSettings] illegal to use on bot clients", callback));
		}
		this._req('get', Endpoints.SETTINGS, (err, res) => {
			handleResCB("Error GETing client settings", err, res, callback);
		});
	}

	/* - DiscordClient - Methods - Content - */

	/**
	 * Upload a file to a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.to - The target Channel or User ID.
	 * @arg {Buffer|String} input.file - A Buffer containing the file data, or a String that's a path to the file.
	 * @arg {String|null} input.filename - A filename for the uploaded file, required if you provide a Buffer.
	 * @arg {String|null} input.message - An optional message to provide.
	 */
	uploadFile(input, callback) {
		/* After like 15 minutes of fighting with Request, turns out Discord doesn't allow multiple files in one message...
		despite having an attachments array.*/
		var file, multi, message, isBuffer, isString;

		multi = new Multipart();
		message = Message.generate(input.message || "");
		isBuffer = (input.file instanceof Buffer);
		isString = (type(input.file) === 'string');

		if (!isBuffer && !isString) return handleErrCB("uploadFile requires a String or Buffer as the 'file' value", callback);
		if (isBuffer) {
			if (!input.filename) return handleErrCB("uploadFile requires a 'filename' value to be set if using a Buffer", callback);
			file = input.file;
		}
		if (isString) try { file = FS.readFileSync(input.file); } catch(e) { return handleErrCB("File does not exist: " + input.file, callback); }

		[
			["content", message.content],
			["mentions", ""],
			["tts", false],
			["nonce", message.nonce],
			["file", file, input.filename || BN(input.file)]
		].forEach(multi.append, multi);
		multi.finalize();

		this.resolveID(input.to, channelID => {
			this._req('post', Endpoints.MESSAGES(channelID), multi, (err, res) => {
				handleResCB("Unable to upload file", err, res, callback);
			});
		});
	}

	/**
	 * Send a message to a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.to - The target Channel or User ID.
	 * @arg {String} input.message - The message content.
	 * @arg {Object} [input.embed] - An embed object to include
	 * @arg {Boolean} [input.tts] - Enable Text-to-Speech for this message.
	 * @arg {Number} [input.nonce] - Number-used-only-ONCE. The Discord client uses this to change the message color from grey to white.
	 * @arg {Boolean} [input.typing] - Indicates whether the message should be sent with simulated typing. Based on message length.
	 */
	sendMessage(input, callback) {
		var message = Message.generate(input.message, input.embed);
		message.tts = (input.tts === true);
		message.nonce = input.nonce || message.nonce;

		if (input.typing) {
			var duration = typeof input.typing === 'number' ?
				input.typing :
				Math.max((message.content.length * 0.12) * 1000, 1000);
			return this.simulateTyping(input.to, duration, () => {
				delete(input.typing);
				this.sendMessage(input, callback);
			});
		}

		this.resolveID(input.to, channelID => {
			this._req('post', Endpoints.MESSAGES(channelID), message, (err, res) => {
				handleResCB("Unable to send messages", err, res, callback);
			});
		});
	}

	/**
	 * Pull a message object from Discord.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID - The channel ID that the message is from.
	 * @arg {Snowflake} input.messageID - The ID of the message.
	 */
	getMessage(input, callback) {
		this._req('get', Endpoints.MESSAGES(input.channelID, input.messageID), (err, res) => {
			handleResCB("Unable to get message", err, res, callback);
		});
	}

	/**
	 * Pull an array of message objects from Discord.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID - The channel ID to pull the messages from.
	 * @arg {Number} [input.limit] - How many messages to pull, defaults to 50.
	 * @arg {Snowflake} [input.before] - Pull messages before this message ID.
	 * @arg {Snowflake} [input.after] - Pull messages after this message ID.
	 */
	getMessages(input, callback) {
		var client = this, qs = {}, messages = [], lastMessageID = "";
		var total = typeof(input.limit) !== 'number' ? 50 : input.limit;

		if (input.before) qs.before = input.before;
		if (input.after) qs.after = input.after;

		(function getMessages() {
			if (total > 100) {
				qs.limit = 100;
				total = total - 100;
			} else {
				qs.limit = total;
			}

			if (messages.length >= input.limit) return call(callback, [null, messages]);

			client._req('get', Endpoints.MESSAGES(input.channelID) + qstringify(qs), (err, res) => {
				if (err) return handleErrCB("Unable to get messages", callback);
				messages = messages.concat(res.body);
				lastMessageID = messages[messages.length - 1] && messages[messages.length - 1].id;
				if (lastMessageID) qs.before = lastMessageID;
				if (!res.body.length < qs.limit) return call(callback, [null, messages]);
				return setTimeout(getMessages, 1000);
			});
		})();
	}

	/**
	 * Edit a previously sent message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {String} input.message - The new message content
	 * @arg {Object} [input.embed] - The new Discord Embed object
	 */
	editMessage(input, callback) {
		this._req('patch', Endpoints.MESSAGES(input.channelID, input.messageID), Message.generate(input.message, input.embed), (err, res) => {
			handleResCB("Unable to edit message", err, res, callback);
		});
	}

	/**
	 * Delete a posted message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	deleteMessage(input, callback) {
		this._req('delete', Endpoints.MESSAGES(input.channelID, input.messageID), (err, res) => {
			handleResCB("Unable to delete message", err, res, callback);
		});
	}

	/**
	 * Delete a batch of messages.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Array<Snowflake>} input.messageIDs - An Array of message IDs, with a maximum of 100 indexes.
	 */
	deleteMessages(input, callback) {
		this._req('post', Endpoints.BULK_DELETE(input.channelID), {messages: input.messageIDs.slice(0, 100)}, (err, res) => {
			handleResCB("Unable to delete messages", err, res, callback);
		});
	}

	/**
	 * Pin a message to the channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	pinMessage(input, callback) {
		this._req('put', Endpoints.PINNED_MESSAGES(input.channelID, input.messageID), (err, res) => {
			handleResCB("Unable to pin message", err, res, callback);
		});
	}

	/**
	 * Get an array of pinned messages from a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 */
	getPinnedMessages(input, callback) {
		this._req('get', Endpoints.PINNED_MESSAGES(input.channelID), (err, res) => {
			handleResCB("Unable to get pinned messages", err, res, callback);
		});
	}

	/**
	 * Delete a pinned message from a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	deletePinnedMessage(input, callback) {
		this._req('delete', Endpoints.PINNED_MESSAGES(input.channelID, input.messageID), (err, res) => {
			handleResCB("Unable to delete pinned message", err, res, callback);
		});
	}

	/**
	 * Send 'typing...' status to a channel
	 * @arg {Snowflake} channelID
	 */
	simulateTyping(channelID, time, callback) {
		if (time <= 0) return callback && callback();

		this._req('post', Endpoints.TYPING(channelID), (err, res) => {
			handleResCB("Unable to simulate typing", err, res, () => {
				setTimeout(this.simulateTyping.bind(this), Math.min(time, 5000), channelID, time - 5000, callback);
			});
		});
	}

	/**
	 * Replace Snowflakes with the names if applicable.
	 * @arg {String} message - The message to fix.
	 * @arg {Snowflake|null} serverID - Optional, the ID of the message's server of origin, used for nickname lookup
	 */
	fixMessage(message, serverID) {
		var client = this;
		return message.replace(/<@&(\d*)>|<@!(\d*)>|<@(\d*)>|<#(\d*)>/g, function(match, RID, NID, UID, CID) {
			var k, i;
			if (UID || CID) {
				if (client.users[UID]) return "@" + client.users[UID].username;
				if (client.channels[CID]) return "#" + client.channels[CID].name;
			}
			if (RID || NID) {
				k = Object.keys(client.servers);
				for (i=0; i<k.length; i++) {
					if (client.servers[k[i]].roles[RID]) return "@" + client.servers[k[i]].roles[RID].name;
					if (client.servers[k[i]].members[NID]) return "@" + client.servers[k[i]].members[NID].nick;
				}
			}
		});
	}

	/**
	 * Add an emoji reaction to a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
	 */
	addReaction(input, callback) {
		// validate: is this.resolveID(input.channelID, channelID => {...}) needed?
		this._req('put', Endpoints.USER_REACTIONS(input.channelID, input.messageID, stringifyEmoji(input.reaction)), (err, res) => {
			handleResCB("Unable to add reaction", err, res, callback);
		});
	}

	/**
	 * Get an emoji reaction of a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
	 * @arg {String} [input.limit]
	 */
	getReaction(input, callback) {
		var qs = { limit: (typeof(input.limit) !== 'number' ? 100 : input.limit) };
		this._req('get', Endpoints.MESSAGE_REACTIONS(input.channelID, input.messageID, stringifyEmoji(input.reaction)) + qstringify(qs), (err, res) => {
			handleResCB("Unable to get reaction", err, res, callback);
		});
	}

	/**
	 * Remove an emoji reaction from a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 * @arg {Snowflake} [input.userID]
	 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
	 */
	removeReaction(input, callback) {
		this._req('delete', Endpoints.USER_REACTIONS(input.channelID, input.messageID, stringifyEmoji(input.reaction), input.userID), (err, res) => {
			handleResCB("Unable to remove reaction", err, res, callback);
		});
	}

	/**
	 * Remove all emoji reactions from a message.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} input.messageID
	 */
	removeAllReactions(input, callback) {
		this._req('delete', Endpoints.MESSAGE_REACTIONS(input.channelID, input.messageID), (err, res) => {
			handleResCB("Unable to remove reactions", err, res, callback);
		});
	}

	/* - DiscordClient - Methods - Guild Management - */

	/**
	 * Remove a user from a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	kick(input, callback) {
		this._req('delete', Endpoints.MEMBERS(input.serverID, input.userID), (err, res) => {
			handleResCB("Could not kick user", err, res, callback);
		});
	}

	/**
	 * Remove and ban a user from a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 * @arg {String} input.reason
	 * @arg {Number} [input.lastDays] - Removes their messages up until this point, either 1 or 7 days.
	 */
	ban(input, callback) {
		var url = Endpoints.BANS(input.serverID, input.userID);
		var opts = {};

		if (input.lastDays) {
			input.lastDays = Number(input.lastDays);
			input.lastDays = Math.min(input.lastDays, 7);
			input.lastDays = Math.max(input.lastDays, 1);
			opts["delete-message-days"] = input.lastDays;
		}

		if (input.reason) opts.reason = input.reason;

		url += qstringify(opts);

		this._req('put', url, (err, res) => {
			handleResCB("Could not ban user", err, res, callback);
		});
	}

	/**
	 * Unban a user from a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	unban(input, callback) {
		this._req('delete', Endpoints.BANS(input.serverID, input.userID), (err, res) => {
			handleResCB("Could not unban user", err, res, callback);
		});
	}

	/**
	 * Move a user between voice channels.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 * @arg {Snowflake} input.channelID
	 */
	moveUserTo(input, callback) {
		this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {channel_id: input.channelID}, (err, res) => {
			handleResCB("Could not move the user", err, res, callback);
		});
	}

	/**
	 * Guild-mute the user from speaking in all voice channels.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	mute(input, callback) {
		this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {mute: true}, (err, res) => {
			handleResCB("Could not mute user", err, res, callback);
		});
	}

	/**
	 * Remove the server-mute from a user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	unmute(input, callback) {
		this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {mute: false}, (err, res) => {
			handleResCB("Could not unmute user", err, res, callback);
		});
	}

	/**
	 * Guild-deafen a user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	deafen(input, callback) {
		this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {deaf: true}, (err, res) => {
			handleResCB("Could not deafen user", err, res, callback);
		});
	}

	/**
	 * Remove the server-deafen from a user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	undeafen(input, callback) {
		this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {deaf: false}, (err, res) => {
			handleResCB("Could not undeafen user", err, res, callback);
		});
	}

	/**
	 * Self-mute the client from speaking in all voice channels.
	 * @arg {Snowflake} serverID
	 */
	muteSelf(serverID, callback) {
		var server = this.servers[serverID], channelID, voiceSession;
		if (!server) return handleErrCB(("Cannot find the server provided: " + serverID), callback);
		
		server.self_mute = true;
		
		if (!server.voiceSession) return call(callback, [null]);
		
		voiceSession = server.voiceSession;
		voiceSession.self_mute = true;
		channelID = voiceSession.channelID;
		if (!channelID) return call(callback, [null]);
		return call(callback, [send(this._ws, Payloads.UPDATE_VOICE(serverID, channelID, true, server.self_deaf))]);
	}

	/**
	 * Remove the self-mute from the client.
	 * @arg {Snowflake} serverID
	 */
	unmuteSelf(serverID, callback) {
		var server = this.servers[serverID], channelID, voiceSession;
		if (!server) return handleErrCB(("Cannot find the server provided: " + serverID), callback);
		
		server.self_mute = false;
		
		if (!server.voiceSession) return call(callback, [null]);
		
		voiceSession = server.voiceSession;
		voiceSession.self_mute = false;
		channelID = voiceSession.channelID;
		if (!channelID) return call(callback, [null]);
		return call(callback, [send(this._ws, Payloads.UPDATE_VOICE(serverID, channelID, false, server.self_deaf))]);
	}

	/**
	 * Self-deafen the client.
	 * @arg {Snowflake} serverID
	 */
	deafenSelf(serverID, callback) {
		var server = this.servers[serverID], channelID, voiceSession;
		if (!server) return handleErrCB(("Cannot find the server provided: " + serverID), callback);
		
		server.self_deaf = true;
		
		if (!server.voiceSession) return call(callback, [null]);
		
		voiceSession = server.voiceSession;
		voiceSession.self_deaf = true;
		channelID = voiceSession.channelID;
		if (!channelID) return call(callback, [null]);
		return call(callback, [send(this._ws, Payloads.UPDATE_VOICE(serverID, channelID, server.self_mute, true))]);
	}

	/**
	 * Remove the self-deafen from the client.
	 * @arg {Snowflake} serverID
	 */
	undeafenSelf(serverID, callback) {
		var server = this.servers[serverID], channelID, voiceSession;
		if (!server) return handleErrCB(("Cannot find the server provided: " + serverID), callback);
		
		server.self_deaf = false;
		
		if (!server.voiceSession) return call(callback, [null]);
		
		voiceSession = server.voiceSession;
		voiceSession.self_deaf = false;
		channelID = voiceSession.channelID;
		if (!channelID) return call(callback, [null]);
		return call(callback, [send(this._ws, Payloads.UPDATE_VOICE(serverID, channelID, server.self_mute, false))]);
	}

	/* Bot server management actions */

	/**
	 * Create a server [User only].
	 * @arg {Object} input
	 * @arg {String} input.name - The server's name
	 * @arg {String} [input.region] - The server's region code, check the Gitbook documentation for all of them.
	 * @arg {String<Base64>} [input.icon] - The last part of a Base64 Data URI. `fs.readFileSync('image.jpg', 'base64')` is enough.
	 */
	createServer(input, callback) {
		var payload = {icon: null, name: null, region: null};
		for (var key in input) {
			if (Object.keys(payload).indexOf(key) < 0) continue;
			payload[key] = input[key];
		}
		if (input.icon) payload.icon = "data:image/jpg;base64," + input.icon;

		this._req('post', Endpoints.SERVERS(), payload, (err, res) => {
			try {
				this.servers[res.body.id] = {};
				copyKeys(res.body, this.servers[res.body.id]);
			} catch(e) {}
			handleResCB("Could not create server", err, res, callback);
		});
	}

	/**
	 * Edit server information.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {String} [input.name]
	 * @arg {String} [input.icon]
	 * @arg {String} [input.region]
	 * @arg {Snowflake} [input.afk_channel_id] - The ID of the voice channel to move a user to after the afk period.
	 * @arg {Number} [input.afk_timeout] - Time in seconds until a user is moved to the afk channel. 60, 300, 900, 1800, or 3600.
	 */
	editServer(input, callback) {
		var payload, serverID = input.serverID, server;
		if (!this.servers[serverID]) return handleErrCB(("[editServer] Guild " + serverID + " not found."), callback);

		server = this.servers[serverID];
		payload = {
			name: server.name,
			icon: server.icon,
			region: server.region,
			afk_channel_id: server.afk_channel_id,
			afk_timeout: server.afk_timeout
		};

		for (var key in input) {
			if (Object.keys(payload).indexOf(key) < 0) continue;
			if (key === 'afk_channel_id') {
				if (server.channels[input[key]] && server.channels[input[key]].type === 'voice') payload[key] = input[key];
				continue;
			}
			if (key === 'afk_timeout') {
				if ([60, 300, 900, 1800, 3600].indexOf(Number(input[key])) > -1) payload[key] = input[key];
				continue;
			}
			payload[key] = input[key];
		}
		if (input.icon) payload.icon = "data:image/jpg;base64," + input.icon;

		this._req('patch', Endpoints.SERVERS(input.serverID), payload, (err, res) => {
			handleResCB("Unable to edit server", err, res, callback);
		});
	}

	/**
	 * Edit the widget information for a server.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID - The ID of the server whose widget you want to edit.
	 * @arg {Boolean} [input.enabled] - Whether or not you want the widget to be enabled.
	 * @arg {Snowflake} [input.channelID] - [Important] The ID of the channel you want the instant invite to point to.
	 */
	editServerWidget(input, callback) {
		var payload, url = Endpoints.SERVERS(input.serverID) + "/embed";

		this._req('get', url, (err, res) => {
			if (err) return handleResCB("Unable to GET server widget settings. Can not edit without retrieving first.", err, res, callback);
			payload = {
				enabled: ('enabled' in input ? input.enabled : res.body.enabled),
				channel_id: ('channelID' in input ? input.channelID : res.body.channel_id)
			};
			this._req('patch', url, payload, (err, res) => {
				handleResCB("Unable to edit server widget", err, res, callback);
			});
		});
	}

	/**
	 * [User Account] Add an emoji to a server
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {String} input.name - The emoji's name
	 * @arg {String<Base64>} input.image - The emoji's image data in Base64
	 */
	addServerEmoji(input, callback) {
		var payload = {
			name: input.name,
			image: "data:image/png;base64," + input.image
		};
		this._req('post', Endpoints.SERVER_EMOJIS(input.serverID), payload, (err, res) => {
			handleResCB("Unable to add emoji to the server", err, res, callback);
		});
	}

	/**
	 * [User Account] Edit a server emoji data (name only, currently)
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.emojiID - The emoji's ID
	 * @arg {String} [input.name]
	 * @arg {Array<Snowflake>} [input.roles] - An array of role IDs you want to limit the emoji's usage to
	 */
	editServerEmoji(input, callback) {
		var emoji, payload = {};
		if ( !this.servers[input.serverID] ) return handleErrCB(("[editServerEmoji] Guild not available: " + input.serverID), callback);
		if ( !this.servers[input.serverID].emojis[input.emojiID]) return handleErrCB(("[editServerEmoji] Emoji not available: " + input.emojiID), callback);

		emoji = this.servers[input.serverID].emojis[input.emojiID];
		payload.name = input.name || emoji.name;
		payload.roles = input.roles || emoji.roles;

		this._req('patch', Endpoints.SERVER_EMOJIS(input.serverID, input.emojiID), payload, (err, res) => {
			handleResCB("[editServerEmoji] Could not edit server emoji", err, res, callback);
		});
	}

	/**
	 * [User Account] Remove an emoji from a server
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.emojiID
	 */
	deleteServerEmoji(input, callback) {
		this._req('delete', Endpoints.SERVER_EMOJIS(input.serverID, input.emojiID), (err, res) => {
			handleResCB("[deleteServerEmoji] Could not delete server emoji", err, res, callback);
		});
	}

	/**
	 * Leave a server.
	 * @arg {Snowflake} serverID
	 */
	leaveServer(serverID, callback) {
		this._req('delete', Endpoints.SERVERS_PERSONAL(serverID), (err, res) => {
			handleResCB("Could not leave server", err, res, callback);
		});
	}

	/**
	 * Delete a server owned by the client.
	 * @arg {Snowflake} serverID
	 */
	deleteServer(serverID, callback) {
		this._req('delete', Endpoints.SERVERS(serverID), (err, res) => {
			handleResCB("Could not delete server", err, res, callback);
		});
	}

	/**
	 * Transfer ownership of a server to another user.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	transferOwnership(input, callback) {
		this._req('patch', Endpoints.SERVERS(input.serverID), {owner_id: input.userID}, (err, res) => {
			handleResCB("Could not transfer server ownership", err, res, callback);
		});
	}

	/**
	 * (Used to) Accept an invite to a server [User Only]. Can no longer be used.
	 * @deprecated
	 */
	acceptInvite(NUL, callback) {
		return handleErrCB("acceptInvite can no longer be used", callback);
	}

	/**
	 * (Used to) Generate an invite URL for a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Number} input.max_age
	 * @arg {Number} input.max_uses
	 * @arg {Boolean} input.temporary
	 * @arg {Boolean} input.unique
	 * 
	 * * @deprecated
	 */
	createInvite(input, callback) {
		var payload, allowed = ["channelID", "max_age", "max_uses", "temporary", "unique"];
		if (Object.keys(input).length === 1 && input.channelID) {
			payload = {
				validate: client.internals.lastInviteCode || null
			};
		} else {
			payload = {
				max_age: 0,
				max_uses: 0, // users? uses?
				temporary: false
			};
		}

		allowed.forEach(function(name) {
			if (input[name]) payload[name] = input[name];
		});

		this._req('post', Endpoints.CHANNEL(payload.channelID) + "/invites", payload, (err, res) => {
			handleResCB('Unable to create invite', err, res, callback);
		});
	}

	/**
	 * Delete an invite code.
	 * @arg {String} inviteCode
	 */
	deleteInvite(inviteCode, callback) {
		this._req('delete', Endpoints.INVITES(inviteCode), (err, res) => {
			handleResCB('Unable to delete invite', err, res, callback);
		});
	}

	/**
	 * Get information on an invite.
	 * @arg {String} inviteCode
	 */
	queryInvite(inviteCode, callback) {
		this._req('get', Endpoints.INVITES(inviteCode), (err, res) => {
			handleResCB('Unable to get information about invite', err, res, callback);
		});
	}

	/**
	 * Get all invites for a server.
	 * @arg {Snowflake} serverID
	 */
	getServerInvites(serverID, callback) {
		this._req('get', Endpoints.SERVERS(serverID) + "/invites", (err, res) => {
			handleResCB('Unable to get invite list for server' + serverID, err, res, callback);
		});
	}

	/**
	 * Get all invites for a channel.
	 * @arg {Snowflake} channelID
	 */
	getChannelInvites(channelID, callback) {
		this._req('get', Endpoints.CHANNEL(channelID) + "/invites", (err, res) => {
			handleResCB('Unable to get invite list for channel' + channelID, err, res, callback);
		});
	}

	/**
	 * Create a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {String} input.name
	 * @arg {String} [input.type] - 'text' or 'voice', defaults to 'text.
	 * @arg {Snowflake} [input.parentID] - category ID?
	 */
	createChannel(input, callback) {
		var payload = {
			name: input.name,
			type: (['text', 'voice'].indexOf(input.type) < 0) ? 'text' : input.type,
			parent_id: input.parentID
		};

		this._req('post', Endpoints.SERVERS(input.serverID) + "/channels", payload, (err, res) => {
			try {
				Channel.create(this, res.body);
			} catch(e) {}
			handleResCB('Unable to create channel', err, res, callback);
		});
	}

	/**
	 * Create a Direct Message channel.
	 * @arg {Snowflake} userID
	 */
	createDMChannel(userID, callback) {
		this._req('post', Endpoints.USER(this.id) + "/channels", {recipient_id: userID}, (err, res) => {
			if (!err && goodResponse(res)) DMChannel.create(this, res.body);
			handleResCB("Unable to create DM Channel", err, res, callback);
		});
	}

	/**
	 * Delete a channel.
	 * @arg {Snowflake} channelID
	 */
	deleteChannel(channelID, callback) {
		this._req('delete', Endpoints.CHANNEL(channelID), (err, res) => {
			handleResCB("Unable to delete channel", err, res, callback);
		});
	}

	/**
	 * Edit a channel's information.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {String} [input.name]
	 * @arg {String} [input.topic] - The topic of the channel.
	 * @arg {Number} [input.bitrate] - [Voice Only] The bitrate for the channel.
	 * @arg {Number} [input.position] - The channel's position on the list.
	 * @arg {Number} [input.user_limit] - [Voice Only] Imposes a user limit on a voice channel.
	 */
	editChannelInfo(input, callback) {
		var channel, payload;

		try {
			channel = this.channels[input.channelID];
			payload = {
				name: channel.name,
				topic: channel.topic,
				bitrate: channel.bitrate,
				position: channel.position,
				user_limit: channel.user_limit,
				nsfw: channel.nsfw,
				parent_id: (input.parentID === undefined ? channel.parent_id : input.parentID)
			};

			for (var key in input) {
				if (Object.keys(payload).indexOf(key) < 0) continue;
				if (+input[key]) {
					if (key === 'bitrate') {
						payload.bitrate = Math.min( Math.max( input.bitrate, 8000), 96000);
						continue;
					}
					if (key === 'user_limit') {
						payload.user_limit = Math.min( Math.max( input.user_limit, 0), 99);
						continue;
					}
				}
				payload[key] = input[key];
			}

			this._req('patch', Endpoints.CHANNEL(input.channelID), payload, (err, res) => {
				handleResCB("Unable to edit channel", err, res, callback);
			});
		} catch(e) {return handleErrCB(e, callback);}
	}

	/**
	 * Edit (or creates) a permission override for a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} [input.userID]
	 * @arg {Snowflake} [input.roleID]
	 * @arg {Array<Number>} input.allow - An array of permissions to allow. Discord.Permissions.XXXXXX.
	 * @arg {Array<Number>} input.deny - An array of permissions to deny, same as above.
	 * @arg {Array<Number>} input.default - An array of permissions that cancels out allowed and denied permissions.
	 */
	editChannelPermissions(input, callback) { //Will shrink this up later
		var payload, pType, ID, channel, permissions, allowed_values;
		if (!input.userID && !input.roleID) return handleErrCB("[editChannelPermissions] No userID or roleID provided", callback);
		if (!this.channels[input.channelID]) return handleErrCB(("[editChannelPermissions] No channel found for ID: " + input.channelID), callback);
		if (!input.allow && !input.deny && !input.default) return handleErrCB("[editChannelPermissions] No allow, deny or default array provided.", callback);

		pType = input.userID ? 'user' : 'role';
		ID = input[pType + "ID"];
		channel = this.channels[ input.channelID ];
		permissions = channel.permissions[pType][ID] || { allow: 0, deny: 0 };
		allowed_values = [0, 4, 28, 29];
		if (channel.type === 'text' || channel.type == Discord.ChannelTypes.GUILD_TEXT || channel.type == Discord.ChannelTypes.GUILD_CATEGORY) {
			allowed_values = allowed_values.concat([6, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
		}
		if (channel.type === 'voice' || channel.type == Discord.ChannelTypes.GUILD_VOICE || channel.type == Discord.ChannelTypes.GUILD_CATEGORY) {
			allowed_values = allowed_values.concat([8, 10, 20, 21, 22, 23, 24, 25]);
		}

		//Take care of allow first
		if (type(input.allow) === 'array') {
			input.allow.forEach(function(perm) {
				if (allowed_values.indexOf(perm) < 0) return;
				if (hasPermission(perm, permissions.deny)) {
					permissions.deny = removePermission(perm, permissions.deny);
				}
				permissions.allow = givePermission(perm, permissions.allow);
			});
		} else if (typeof input.allow === 'number') { //If people want to be a smartass and calculate their permission number themselves.
			permissions.allow = input.allow;
		}
		//Take care of deny second
		if (type(input.deny) === 'array') {
			input.deny.forEach(function(perm) {
				if (allowed_values.indexOf(perm) < 0) return;
				if (hasPermission(perm, permissions.allow)) {
					permissions.allow = removePermission(perm, permissions.allow);
				}
				permissions.deny = givePermission(perm, permissions.deny);
			});
		} else if (typeof input.deny === 'number') {
			permissions.deny = input.deny;
		}
		//Take care of defaulting last
		if (type(input.default) === 'array') {
			input.default.forEach(function(perm) {
				if (allowed_values.indexOf(perm) < 0) return;
				permissions.allow = removePermission(perm, permissions.allow);
				permissions.deny = removePermission(perm, permissions.deny);
			});
		} else if (typeof input.default === 'number') {
			permissions.default = input.default
		}

		payload = {
			type: (pType === 'user' ? 'member' : 'role'),
			id: ID,
			deny: permissions.deny,
			allow: permissions.allow
		};

		this._req('put', Endpoints.CHANNEL(input.channelID) + "/permissions/" + ID, payload, (err, res) => {
			handleResCB('Unable to edit permission', err, res, callback);
		});
	}

	/**
	 * Delete a permission override for a channel.
	 * @arg {Object} input
	 * @arg {Snowflake} input.channelID
	 * @arg {Snowflake} [input.userID]
	 * @arg {Snowflake} [input.roleID]
	 */
	deleteChannelPermission(input, callback) {
		var payload, pType, ID;
		if (!input.userID && !input.roleID) return handleErrCB("[deleteChannelPermission] No userID or roleID provided", callback);
		if (!this.channels[input.channelID]) return handleErrCB(("[deleteChannelPermission] No channel found for ID: " + input.channelID), callback);

		pType = input.userID ? 'user' : 'role';
		ID = input[pType + "ID"];

		payload = {
			type: (pType === 'user' ? 'member' : 'role'),
			id: ID
		};

		this._req('delete', Endpoints.CHANNEL(input.channelID) + "/permissions/" + ID, payload, (err, res) => {
			handleResCB('Unable to delete permission', err, res, callback);
		});
	}

	/**
	 * Create a role for a server.
	 * @arg {Snowflake} serverID
	 */
	createRole(serverID, callback) {
		this._req('post', Endpoints.ROLES(serverID), (err, res) => {
			try {
				Role.create(this, res.body);
			} catch(e) {}
			handleResCB("Unable to create role", err, res, callback);
		});
	}

	/**
	 * Edit a role.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.roleID - The ID of the role.
	 * @arg {String} [input.name]
	 * @arg {String} [input.color] - A color value as a number. Recommend using Hex numbers, as they can map to HTML colors (0xF35353 === #F35353).
	 * @arg {Boolean} [input.hoist] - Separates the users in this role from the normal online users.
	 * @arg {Object} [input.permissions] - An Object containing the permission as a key, and `true` or `false` as its value. Read the Permissions doc.
	 * @arg {Boolean} [input.mentionable] - Toggles if users can @Mention this role.
	 */
	editRole(input, callback) {
		var role, payload;
		try {
			role = new Role(this.servers[input.serverID].roles[input.roleID]);
			payload = {
				name: role.name,
				color: role.color,
				hoist: role.hoist,
				permissions: role._permissions,
				mentionable: role.mentionable,
				position: role.position
			};

			for (var key in input) {
				if (Object.keys(payload).indexOf(key) < 0) continue;
				if (key === 'permissions') {
					for (var perm in input[key]) {
						role[perm] = input[key][perm];
						payload.permissions = role._permissions;
					}
					continue;
				}
				if (key === 'color') {
					if (String(input[key])[0] === '#') payload.color = parseInt(String(input[key]).replace('#', '0x'), 16);
					if (Discord.Colors[input[key]]) payload.color = Discord.Colors[input[key]];
					if (type(input[key]) === 'number') payload.color = input[key];
					continue;
				}
				payload[key] = input[key];
			}
			this._req('patch', Endpoints.ROLES(input.serverID, input.roleID), payload, (err, res) => {
				handleResCB("Unable to edit role", err, res, callback);
			});
		} catch(e) {return handleErrCB(('[editRole] ' + e), callback);}
	}

	/**
	 * Move a role up or down relative to it's current position.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.roleID - The ID of the role.
	 * @arg {Number} input.position - A relative number to move the role up or down.
	 */
	moveRole(input, callback) {
		if (input.position === 0) return handleErrCB("Desired role position is same as current", callback); // Don't do anything if they don't want it to move

		try {
			var server = this.servers[input.serverID];
			var role   = server.roles[input.roleID];
			var curPos = role.position;
			var newPos = curPos + input.position;
			newPos = Math.max(newPos, 1);
			newPos = Math.min(newPos, Object.keys(server.roles).length - 1);

			var currentOrder = [];
			for (var roleID in server.roles) {
				if (roleID == input.serverID) continue; // skip @everyone
				currentOrder.push(server.roles[roleID]);
			}
			currentOrder.splice(newPos - 1, 0, role);
			
			var payload = currentOrder.map((role,idx) => ({id: role.id, position: idx+1}));

			this._req('patch', Endpoints.ROLES(input.serverID), payload, (err, res) => {
				handleResCB("Unable to move role", err, res, callback);
			});
		} catch (e) {return handleErrCB(e, callback);}
	}

	/**
	 * Delete a role.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.roleID
	 */
	deleteRole(input, callback) {
		this._req('delete', Endpoints.ROLES(input.serverID, input.roleID), (err, res) => {
			handleResCB("Could not remove role", err, res, callback);
		});
	}

	/**
	 * Add a user to a role.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.roleID
	 * @arg {Snowflake} input.userID
	 */
	addToRole(input, callback) {
		this._req('put', Endpoints.MEMBER_ROLES(input.serverID, input.userID, input.roleID), (err, res) => {
			handleResCB("Could not add role", err, res, callback);
		});
	}

	/**
	 * Remove a user from a role.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.roleID
	 * @arg {Snowflake} input.userID
	 */
	removeFromRole(input, callback) {
		this._req('delete', Endpoints.MEMBER_ROLES(input.serverID, input.userID, input.roleID), (err, res) => {
			handleResCB("Could not remove role", err, res, callback);
		});
	}

	/**
	 * Edit a user's nickname.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 * @arg {String} input.nick - The nickname you'd like displayed.
	 */
	editNickname(input, callback) {
		var payload = {nick: String( input.nick ? input.nick : "" )};
		var url = input.userID === this.id ?
			Endpoints.MEMBERS(input.serverID) + "/@me/nick" :
			Endpoints.MEMBERS(input.serverID, input.userID);

		this._req('patch', url, payload, (err, res) => {
			handleResCB("Could not change nickname", err, res, callback);
		});
	}

	/**
	 * Edit a user's note.
	 * @arg {Object} input
	 * @arg {Snowflake} input.userID
	 * @arg {String} input.note - The note content that you want to use.
	 */
	editNote(input, callback) {
		this._req('put', Endpoints.NOTE(input.userID), {note: input.note}, (err, res) => {
			handleResCB("Could not edit note", err, res, callback);
		});
	}

	/**
	 * Retrieve a user object from Discord, the library already caches users, however.
	 * @arg {Object} input
	 * @arg {Snowflake} input.serverID
	 * @arg {Snowflake} input.userID
	 */
	getMember(input, callback) {
		this._req('get', Endpoints.MEMBERS(input.serverID, input.userID), (err, res) => {
			handleResCB("Could not get member", err, res, callback);
		});
	}

	/**
	 * Retrieve a group of user objects from Discord.
	 * @arg {Object} input
	 * @arg {Number} [input.limit] - The amount of users to pull, defaults to 50.
	 * @arg {Snowflake} [input.after] - The offset using a user ID.
	 */
	getMembers(input, callback) {
		var qs = {};
		qs.limit = (typeof(input.limit) !== 'number' ? 50 : input.limit);
		if (input.after) qs.after = input.after;

		this._req('get', Endpoints.MEMBERS(input.serverID) + qstringify(qs), (err, res) => {
			handleResCB("Could not get members", err, res, callback);
		});
	}

	/**
	 * Get the ban list from a server
	 * @arg {Snowflake} serverID
	 */
	getBans(serverID, callback) {
		this._req('get', Endpoints.BANS(serverID), (err, res) => {
			handleResCB("Could not get ban list", err, res, callback);
		});
	}

	/**
	 * Get all webhooks for a server
	 * @arg {Snowflake} serverID
	 */
	getServerWebhooks(serverID, callback) {
		this._req('get', Endpoints.SERVER_WEBHOOKS(serverID), (err, res) => {
			handleResCB("Could not get server Webhooks", err, res, callback);
		});
	}

	/**
	 * Get webhooks from a channel
	 * @arg {Snowflake} channelID
	 */
	getChannelWebhooks(channelID, callback) {
		this._req('get', Endpoints.CHANNEL_WEBHOOKS(channelID), (err, res) => {
			handleResCB("Could not get channel Webhooks", err, res, callback);
		});
	}

	/**
	 * Create a webhook for a server
	 * @arg {Snowflake} serverID
	 */
	createWebhook(serverID, callback) {
		this._req('post', Endpoints.SERVER_WEBHOOKS(serverID), (err, res) => {
			handleResCB("Could not create a Webhook", err, res, callback);
		});
	}

	/**
	 * Edit a webhook
	 * @arg {Object} input
	 * @arg {Snowflake} input.webhookID - The Webhook's ID
	 * @arg {String} [input.name]
	 * @arg {String<Base64>} [input.avatar]
	 * @arg {String} [input.channelID]
	 */
	editWebhook(input, callback) {
		var payload = {}, allowed = ['avatar', 'name'];
		this._req('get', Endpoints.WEBHOOKS(input.webhookID), (err, res) => {
			if (err || !goodResponse(res)) return handleResCB("Couldn't get webhook, do you have permissions to access it?", err, res, callback);
			allowed.forEach(function(key) {
				payload[key] = (key in input ? input[key] : res.body[key]);
			});
			payload.channel_id = input.channelID || res.body.channel_id;

			this._req('patch', Endpoints.WEBHOOKS(input.webhookID), payload, (err, res) => {
				return handleResCB("Couldn't update webhook", err, res, callback);
			});
		});
	}

	/* --- Voice --- */

	/**
	 * Join a voice channel.
	 * @arg {Snowflake} channelID
	 */
	joinVoiceChannel(channelID, callback) {
		var serverID, server, channel, voiceSession;
		try {
			serverID = this.channels[channelID].guild_id;
			server = this.servers[serverID];
			channel = server.channels[channelID];
		} catch(e) {}
		if (!serverID) return handleErrCB(("Cannot find the server related to the channel provided: " + channelID), callback);
		if (channel.type !== 'voice' && channel.type !== 2) return handleErrCB(("Selected channel is not a voice channel: " + channelID), callback);
		if (this._vChannels[channelID]) return handleErrCB(("Voice channel already active: " + channelID), callback);

		voiceSession = this.getVoiceSession(channelID, server);
		voiceSession.self_mute = server.self_mute;
		voiceSession.self_deaf = server.self_deaf;
		this.checkVoiceReady(voiceSession, callback);
		return send(this._ws, Payloads.UPDATE_VOICE(serverID, channelID, server.self_mute, server.self_deaf));
	}

	/**
	 * Leave a voice channel.
	 * @arg {Snowflake} channelID
	 */
	leaveVoiceChannel(channelID, callback) {
		if (!this._vChannels[channelID]) return handleErrCB(("Not in the voice channel: " + channelID), callback);
		return this._leaveVoiceChannel(channelID, callback);
	}

	/**
	 * Prepare the client for sending/receiving audio.
	 * @arg {Snowflake|Object} channelObj - Either the channel ID, or an Object with `channelID` as a key and the ID as the value.
	 * @arg {Number} [channelObj.maxStreamSize] - The size in KB that you wish to receive before pushing out earlier data. Required if you want to store or receive incoming audio.
	 * @arg {Boolean} [channelObj.stereo] - Sets the audio to be either stereo or mono. Defaults to true.
	 */
	getAudioContext(channelObj, callback) {
		// #q/qeled gave a proper timing solution. Credit where it's due.
		if (!isNode) return handleErrCB("Using audio in the browser is currently not supported.", callback);
		var channelID = channelObj.channelID || channelObj,
			voiceSession = this._vChannels[channelID],
			encoder = this.chooseAudioEncoder(['ffmpeg', 'avconv']);

		if (!voiceSession) return handleErrCB(("You have not joined the voice channel: " + channelID), callback);
		if (voiceSession.ready !== true) return handleErrCB(("The connection to the voice channel " + channelID + " has not been initialized yet."), callback);
		if (!encoder) return handleErrCB("You need either 'ffmpeg' or 'avconv' and they need to be added to PATH", callback);

		voiceSession.audio = voiceSession.audio || new AudioCB(
			voiceSession,
			channelObj.stereo === false ? 1 : 2,
			encoder,
			Math.abs(Number(channelObj.maxStreamSize)));

		return call(callback, [null, voiceSession.audio]);
	}

	/* --- Misc --- */

	/**
	 * Retrieves all offline (and online, if using a user account) users, fires the `allUsers` event when done.
	 */
	getAllUsers(callback) {
		var servers = Object.keys(this.servers).filter(function(s) {
				s = this.servers[s];
				if (s.members) return s.member_count !== Object.keys(s.members).length && (this.bot ? s.large : true);
			}, this);

		if (!servers[0]) {
			this.emit('allUsers');
			return handleErrCB("There are no users to be collected", callback);
		}
		if (!this.bot) send(this._ws, Payloads.ALL_USERS(this));

		return this.getOfflineUsers(servers, callback);
	}

	resolveID(ID, callback) {
		/*Get channel from ServerID, ChannelID or UserID.
		Only really used for sendMessage and uploadFile.*/
		//Callback used instead of return because requesting seems necessary.

		if (this._uIDToDM[ID]) return callback(this._uIDToDM[ID]);
		//If it's a UserID, and it's in the UserID : ChannelID cache, use the found ChannelID

		//If the ID isn't in the UserID : ChannelID cache, let's try seeing if it belongs to a user.
		if (this.users[ID]) return this.createDMChannel(ID, function(err, res) {
			if (err) return console.log("Internal ID resolver error: " + JSON.stringify(err));
			callback(res.id);
		});

		return callback(ID); //Finally, the ID must not belong to a User, so send the message directly to it, as it must be a Channel's.
	}
	checkForAllServers(ready, message) {
		var all = Object.keys(this.servers).every(s => !this.servers[s].unavailable);
		if (all || ready[0]) return void(this._ready = true && this.emit('ready', message));
		return setTimeout(this.checkForAllServers.bind(this), 0, ready, message);
	}
	cacheMessage(message) {
		var cache = this._messageCache,
			limit = this._messageCacheLimit,
			channelID = message.channel_id;
		if (!cache[channelID]) cache[channelID] = {};
		if (limit !== -1) {
			var k = Object.keys(cache[channelID]);
			if (k.length > limit) delete(cache[channelID][k[0]]);
		}
		cache[channelID][message.id] = message;
	}
	getCacheMessage(channelID, messageID) {
		var cache = this._messageCache;
		if (!cache[channelID]) return null;
		return cache[channelID][messageID] || null;
	}

	/* --- Initializing --- */

	init(options = {}) {
		this.servers = {};
		this.channels = {};
		this.users = {};
		this.directMessages = {};
		this.internals = {
			oauth: {},
			version: CURRENT_VERSION,
			settings: {}
		};
		this._connecting = true;

		this.setupPing();
		return this.getToken(options);
	}
	getToken(options = {}) {
		if (options.token) return this.getGateway(options.token);
		if (!isNode) {
			//Read from localStorage? Sounds like a bad idea, but I'll leave this here.
		}
	}
	getGateway(token) {
		this.internals.token = token;
		return APIRequest('get', Endpoints.GATEWAY, (err, res) => {
			if (err || !goodResponse(res)) {
				this._connecting = false;
				return this.emit("disconnect", "Error GETing gateway:\n" + stringifyError(res), 0);
			}
			return this.startConnection(res.body.url + "/?encoding=json&v=" + GATEWAY_VERSION);
		});
	}
	startConnection(gateway) {
		this._ws = new Websocket(gateway);
		this.internals.gatewayUrl = gateway;

		this._ws.once('close', this.handleWSClose.bind(this));
		this._ws.once('error', this.handleWSClose.bind(this));
		this._ws.on('message', this.handleWSMessage.bind(this));
	}
	getOfflineUsers(servArr, callback) {
		if (!servArr[0]) return call(callback);

		send(this._ws, Payloads.OFFLINE_USERS(servArr));
		return setTimeout( this.getOfflineUsers.bind(this), 0, servArr, callback );
	}
	setupPing() {
		var obj = this.internals;
		applyProperties(obj, [
			["_pings", []],
			["_lastHB", 0]
		]);
		Object.defineProperty(obj, 'ping', {
			get() {
				return ((obj._pings.reduce(function(p, c) { return p + c; }, 0) / obj._pings.length) || 0) | 0;
			},
			set() {}
		});
	}
	validateShard(shard) {
		return (
			type(shard)  === 'array' &&
			shard.length === 2       &&
			shard[0] <= shard[1]     &&
			shard[1] > 1
		) ? shard : null;
	}
	identifyOrResume() {
		var payload, internals = this.internals;

		if (internals.sequence && internals.token && internals.sessionID) {
			payload = Payloads.RESUME(this);
		} else {
			payload = Payloads.IDENTIFY(this);
			if (this._shard) payload.d.shard = this._shard;
		}
		this._connecting = false;

		return send(this._ws, payload);
	}

	/* - Functions - Websocket Handling - */

	handleWSMessage(data, flags) {
		var message = decompressWSMessage(data, flags);

		switch (message.op) {
			case Discord.Codes.Gateway.DISPATCH:
				//Event dispatched - update our sequence number
				this.internals.sequence = message.s;
				break;

			case Discord.Codes.Gateway.HEARTBEAT:
				//Heartbeat requested by Discord - send one immediately
				send(this._ws, Payloads.HEARTBEAT(this));
				break;

			case Discord.Codes.Gateway.RECONNECT:
				//Reconnect requested by discord
				clearTimeout(this.internals.heartbeat);
				this._ws.close(1000, 'Reconnect requested by Discord');
				break;

			case Disord.Codes.Gateway.INVALID_SESSION:
				//Disconnect after an Invalid Session
				//Disconnect the client if the client has received an invalid session id
				if(!message.d) {
					delete(this.internals.sequence);
					delete(this.internals.sessionID);
					//Send new identify after 1-5 seconds, chosen randomly (per Gateway docs)
					setTimeout(() => this.identifyOrResume(), Math.random()*4000+1000);
				} else this.identifyOrResume();
				break;

			case Discord.Codes.Gateway.HELLO:
				//Start keep-alive interval
				//Disconnect the client if no ping has been received
				//in 15 seconds (I think that's a decent duration)
				//Since v3 you send the IDENTIFY/RESUME payload here.
				this.identifyOrResume();
				//if (!this.presence) this.presence = { status: "online", since: Date.now() };
				client.presenceStatus = 'online';
				this.connected = true;

				this._mainKeepAlive = setInterval(() => {
					this.internals.heartbeat = setTimeout(() => {
						this._ws && this._ws.close(1001, "No heartbeat received");
					}, message.d.heartbeat_interval);
					this.internals._lastHB = Date.now();
					send(this._ws, Payloads.HEARTBEAT(this));
				},  message.d.heartbeat_interval);
				break;

			case Discord.Codes.Gateway.HEARTBEAK_ACK:
				clearTimeout(this.internals.heartbeat);
				this.internals._pings.unshift(Date.now() - this.internals._lastHB);
				this.internals._pings = this.internals._pings.slice(0, 10);
				break;
		}

		//Events
		this.emit('any', message);
		//TODO: Remove in v3
		this.emit('debug', message);
		
		try {
			let evt = Discord.Events[message.t];
			console.log(evt);
			return this['handleWS'+evt](message, message.d);
		} catch (e) {}
	}
	handleWSready(message, data) {
		copyKeys(data.user, this);
		this.internals.sessionID = data.session_id;

		// get Server Info
		for (let server of data.guilds) {
			Guild.create(this, server);
		}
		// get Direct Messages
		for (let DM of data.private_channels) {
			DMChannel.create(this, DM);
		}

		if (this.bot) this.getOauthInfo((err, res) => {
			if (err) return console.log(err);
			this.internals.oauth = res;
			this.inviteURL = "https://discordapp.com/oauth2/authorize?client_id=" + res.id + "&scope=bot";
		});
		if (!this.bot) this.getAccountSettings((err, res) => {
			if (err) return console.log(err);
			this.internals.settings = res;
		});

		return (function() {
			if (this._ready) return;
			var ready = [false];
			setTimeout(function() { ready[0] = true; }, 3500);
			this.checkForAllServers(ready, message);
		}).call(this);
	}
	handleWSmessageCreate(message, data) {
		this.emit('message', data.author.username, data.author.id, data.channel_id, data.content, message);
		emit(this, message, data.author.username, data.author.id, data.channel_id, data.content);
		return this.cacheMessage(data);
	}
	handleWSmessageUpdate(message, data) {
		try {
			// if a message that existed before the client went online gets updated/edited,
			// then this will not have a cached version of the message
			var old = copy(this.getCacheMessage(data.channel_id, data.id));
			emit(this, message, old, data);
		} catch (e) { emit(this, message, undefined, data); }
		return this.cacheMessage(data);
	}
	handleWSpresenceUpdate(message, data) {
		if (!data.guild_id) return;

		var serverID = data.guild_id;
		var userID = data.user.id;

		if (!this.users[userID]) User.create(this, data.user);

		var user = this.users[userID];
		var member = this.servers[serverID].members[userID] || {};

		copyKeys(data.user, user);
		user.game = data.game;

		copyKeys(data, member, ['user', 'guild_id', 'game']);
		this.emit('presence', user.username, user.id, member.status, user.game, message);
		return emit(this, message);
	}
	handleWSuserUpdate(message, data) {
		User.update(this, data);
		return emit(this, message);
	}
	handleWSuserSettingsUpdate(message, data) {
		copyKeys(data, this.internals);
		return emit(this, message);
	}
	handleWSguildCreate(message, data) {
		return emit(this, message, Guild.create(this, data));
	}
	handleWSguildUpdate(message, data) {
		var old = copy(this.servers[data.id]);
		return emit(this, message, old, Guild.update(this, data));
	}
	handleWSguildDelete(message, data) {
		return emit(this, message, Guild.delete(this, data));
	}
	handleWSguildMemberAdd(message, data) {
		// Add or replace User object.
		User.create(this, data.user);
		return emit(this, message, Member.create(this, data));
	}
	handleWSguildMemberUpdate(message, data) {
		var server = this.servers[data.guild_id];
		var old    = copy(server.members[data.user.id]);
		return emit(this, message, old, Member.update(this, data));
	}
	handleWSguildMemberRemove(message, data) {
		if (data.user && data.user.id === this.id) return;
		return emit(this, message, Member.delete(this, data));
	}
	handleWSguildRoleCreate(message, data) {
		return emit(this, message, Role.create(this, data));
	}
	handleWSguildRoleUpdate(message, data) {
		var server = this.servers[data.guild_id];
		var old    = copy(server.roles[data.role.id]);
		return emit(this, message, old, Role.update(this, data));
	}
	handleWSguildRoleDelete(message, data) {
		var server = this.servers[data.guild_id];
		return emit(this, message, Role.delete(this, data));
		//return emit(this, message);
	}
	handleWSchannelCreate(message, data) {
		var channel;
		if (data.is_private || data.type == Discord.ChannelTypes.DM) {
			if (this.directMessages[data.id]) return; // already have this
			channel = DMChannel.create(this, data);
		} else {
			if (this.channels[data.id]) return;
			channel = Channel.create(this, data);
		}
		return emit(this, message, channel);
	}
	handleWSchannelUpdate(message, data) {
		var old = copy(this.channels[data.id]);
		return emit(this, message, old, Channel.update(this, data));
	}
	handleWSchannelDelete(message, data) {
		if (data.is_private || data.type == Discord.ChannelTypes.DM) {
			return emit(this, message, DMChannel.delete(this, data));
		}
		return emit(this, message, Channel.delete(this, data));
	}
	handleWSguildEmojisUpdate(message, data) {
		var server = this.servers[data.guild_id];
		var old    = copy(server.emojis);
		return emit(this, message, old, Emoji.update(client, data.emojis));
	}
	handleWSvoiceStateUpdate(message, data) {
		var serverID = data.guild_id,
			channelID = data.channel_id,
			userID = data.user_id,
			server = this.servers[serverID],
			mute = !!data.mute,
			self_mute = !!data.self_mute,
			deaf = !!data.deaf,
			self_deaf = !!data.self_deaf;

		try {
			currentVCID = server.members[userID].voice_channel_id;
			if (currentVCID) delete( server.channels[currentVCID].members[userID] );
			if (channelID) server.channels[channelID].members[userID] = data;
			server.members[userID].mute = (mute || self_mute);
			server.members[userID].deaf = (deaf || self_deaf);
			server.members[userID].voice_channel_id = channelID;
		} catch(e) {}

		if (userID === this.id) {
			server.self_mute = self_mute;
			server.self_deaf = self_deaf;
			if (channelID === null) {
				if (server.voiceSession) this._leaveVoiceChannel(server.voiceSession.channelID);
				server.voiceSession = null;
			} else {
				if (!server.voiceSession) {
					server.voiceSession = this.getVoiceSession(channelID, server);
				}
				if (channelID !== server.voiceSession.channelID) {
					delete( this._vChannels[server.voiceSession.channelID] );
					this.getVoiceSession(channelID, server).channelID = channelID;
				}

				server.voiceSession.session = data.session_id;
				server.voiceSession.self_mute = self_mute;
				server.voiceSession.self_deaf = self_deaf;
			}
		}
		return emit(this, message);
	}
	handleWSvoiceServerUpdate(message, data) {
		var serverID = data.guild_id;
		var server = this.servers[serverID];
		server.voiceSession.token    = data.token;
		server.voiceSession.serverID = serverID;
		server.voiceSession.endpoint = data.endpoint;
		this.joinVoiceChannel(server.voiceSession);
		return emit(this, message);
	}
	handleWSguildMembersChunk(message, data) {
		Guild.sync(this, data);

		// tally up the number of existing members and compare with the expected member count
		var all = Object.keys(this.servers).every(function(serverID) {
			var server = client.servers[serverID];
			return server.member_count === Object.keys(server.members).length;
		});
		if (all) return this.emit("allUsers");

		return emit(this, message);
	}
	handleWSguildSync(message, data) {
		Guild.sync(this, data);
		return emit(this, message);
	}
	handleWSClose(code, data) {
		var eMsg = Discord.Codes.WebSocket[code] || data;

		clearInterval(this._mainKeepAlive);
		this.connected = false;
		removeAllListeners(this._ws, 'message');

		if ([1001, 1006].indexOf(code) > -1) return this.getGateway(this.internals.token);

		this._ready = false;
		this._ws = null;

		this.emit("disconnect", eMsg, code);
	}

	/* - Functions - Voice - */

	_joinVoiceChannel(voiceSession) {
		var vWS, vUDP, endpoint = voiceSession.endpoint.split(":")[0];
		//this.handleVoiceChannelChange(voiceSession);

		voiceSession.ws = {};
		voiceSession.udp = {};
		voiceSession.members = {};
		voiceSession.error = null;
		voiceSession.ready = false;
		voiceSession.joined = false;
		voiceSession.translator = {};
		voiceSession.wsKeepAlive = null;
		voiceSession.udpKeepAlive = null;
		voiceSession.keepAlivePackets = 0;
		voiceSession.emitter = new EventEmitter();
		if (isNode) voiceSession.keepAliveBuffer = new Buffer(8).fill(0);
		vWS = voiceSession.ws.connection = new Websocket("wss://" + endpoint);

		if (isNode) return DNS.lookup(endpoint, (err, address) => {
			if (err) return void(voiceSession.error = err);

			voiceSession.address = address;
			vUDP = voiceSession.udp.connection = UDP.createSocket("udp4");

			vUDP.bind({exclusive: true});
			vUDP.once('message', handleUDPMessage.bind(this, voiceSession));

			vWS.once('open',  this.handlevWSOpen.bind(this, voiceSession));
			vWS.on('message', this.handlevWSMessage.bind(this, voiceSession));
			vWS.once('close', this.handlevWSClose.bind(this, voiceSession));
		});

		vWS.once('open',  this.handlevWSOpen.bind(this, voiceSession));
		vWS.on('message', this.handlevWSMessage.bind(this, voiceSession));
		vWS.once('close', this.handlevWSClose.bind(this, voiceSession));
		return void(voiceSession.joined = true);
	}
	_leaveVoiceChannel(channelID, callback) {
		if (!this._vChannels[channelID]) return;

		try {
			this._vChannels[channelID].ws.connection.close();
			this._vChannels[channelID].udp.connection.close();
		} catch(e) {}

		send(this._ws, Payloads.UPDATE_VOICE(this.channels[channelID].guild_id, null, false, false));

		return call(callback, [null]);
	}
	getVoiceSession(channelID, server) {
		if (!channelID) return null;
		return this._vChannels[channelID] ?
		this._vChannels[channelID] :
		this._vChannels[channelID] = (server && server.voiceSession) || new VoiceSession(server, channelID);
	}
	checkVoiceReady(voiceSession, callback) {
		return setTimeout(() => {
			if (voiceSession.error) return call(callback, [voiceSession.error]);
			if (voiceSession.joined) return call(callback, [null, voiceSession.emitter]);
			return this.checkVoiceReady(voiceSession, callback);
		}, 1);
	}

	/* - Functions - Voice - Handling - */

	handlevWSOpen(voiceSession) {
		return send(voiceSession.ws.connection, Payloads.VOICE_IDENTIFY(this.id, voiceSession));
	}
	handlevWSMessage(voiceSession, vMessage, vFlags) {
		var vData = decompressWSMessage(vMessage, vFlags);
		switch (vData.op) {
			case Discord.Voice.READY:
				//Ready (Actually means you're READY to initiate the UDP connection)
				this.handlevWSready(voiceSession, vData);
				break;

			case Discord.Voice.SESSION_DESCRIPTION:
				//Session Description (Actually means you're ready to send audio... stupid Discord Devs :I)
				this.handlevWSsessionDescription(voiceSession, vData);
				break;

			case Discord.Voice.SPEAKING:
				//Speaking (At least this isn't confusing!)
				this.handlevWSspeaking(voiceSession, vData);
				break;
		}
	}
	handlevWSready(voiceSession, vData) {
		copyKeys(vData.d, voiceSession.ws);
		voiceSession.initKeepAlive(vData);

		if (!isNode) return;

		var udpDiscPacket = new Buffer(70);
		udpDiscPacket.writeUIntBE(vData.d.ssrc, 0, 4);
		voiceSession.udp.connection.send(
			udpDiscPacket, 0, udpDiscPacket.length, vData.d.port, voiceSession.address,
			err => { 
				if (err) {
					this._leaveVoiceChannel(voiceSession.channelID); 
					handleErrCB("UDP discovery error", callback); 
				}
			});

		return void(voiceSession.udpKeepAlive = setInterval(keepUDPAlive, 5000, voiceSession));
	}
	handlevWSsessionDescription(voiceSession, vData) {
		voiceSession.prepareToSend(vData);
	}
	handlevWSspeaking(voiceSession, vData) {
		voiceSession.receiveSpeaking(vData);
	}
	handlevWSClose(voiceSession) {
		//Emit the disconnect event first
		voiceSession.emitter.emit("disconnect", voiceSession.channelID);
		voiceSession.emitter = null
		//Kill encoder and decoders
		var audio = voiceSession.audio, members = voiceSession.members;
		if (audio) {
			if (audio._systemEncoder) audio._systemEncoder.kill();
			if (audio._mixedDecoder) audio._mixedDecoder.destroy();
		}

		Object.keys(members).forEach(function(ID) {
			var member = members[ID];
			if (member.decoder) member.decoder.destroy();
		});

		//Clear intervals and remove listeners
		clearInterval(voiceSession.wsKeepAlive);
		clearInterval(voiceSession.udpKeepAlive);
		removeAllListeners(voiceSession.emitter);
		removeAllListeners(voiceSession.udp.connection, 'message');
		removeAllListeners(voiceSession.ws.connection, 'message');

		return delete(this._vChannels[voiceSession.channelID]);
	}
	handleUDPMessage(voiceSession, msg, rinfo) {
		var buffArr = JSON.parse(JSON.stringify(msg)).data, vDiscIP = "", vDiscPort;
		for (var i=4; i<buffArr.indexOf(0, i); i++) {
			vDiscIP += String.fromCharCode(buffArr[i]);
		}
		vDiscPort = msg.readUIntLE(msg.length - 2, 2).toString(10);
		return send(voiceSession.ws.connection, Payloads.VOICE_DISCOVERY(vDiscIP, vDiscPort, 'xsalsa20_poly1305'));
	}
}

/* - Discord Classes - Resources - */
class Resource {
	constructor(data, options) { if (data) copyKeys(data, this, options); }
	get creationTime() { return (+this.id / 4194304) + 1420070400000; }
	update(data) { copyKeys(data, this); }
	static create() {}
	static update() {}
	static delete() {}
}
class Message extends Resource {
	constructor(msg = {}) {
		this.type    = msg.type || Discord.MessageTypes.DEFAULT;
		this.content = String(msg.content||'');
		this.nonce   = msg.nonce || Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
		this.embed   = msg.embed || {};
		for (let key in msg) {
			if (!(key in this)) this[key] = msg[key];
		}
	}
	static generate(message = '', embed = {}) {
		return new Message({content: message, embed});
	}
}
class Guild extends Resource {
	constructor(client, data) {
		//Accept everything now and trim what we don't need, manually. Any data left in is fine, any data left out could lead to a broken lib.
		super(data);

		this.large = this.large || this.member_count > LARGE_THRESHOLD;
		this.voiceSession = null;
		this.self_mute = !!this.self_mute;
		this.self_deaf = !!this.self_deaf;
		if (data.unavailable) return;
	
		//Objects so we can use direct property accessing without for loops
		this.channels = {};
		this.members = {};
		this.roles = {};
		this.emojis = {};
	
		//Copy the data into the objects using IDs as keys
		data.channels.forEach(channel => {
			this.addChannel(client, channel);
		});
		data.roles.forEach(role => {
			this.addRole(role);
		});
		data.members.forEach(member => {
			User.create(client, member.user);
			this.addMember(client, member);
		});
		data.presences.forEach(presence => {
			var id = presence.user.id;
			if (!client.users[id] || !this.members[id]) return;
			delete(presence.user);
	
			client.users[id].game = presence.game;
			this.members[id].status = presence.status;
		});
		data.emojis.forEach(emoji => {
			this.addEmoji(emoji);
		});
		data.voice_states.forEach(vs => {
			var cID = vs.channel_id;
			var uID = vs.user_id;
			if (!this.channels[cID] || !this.members[uID]) return;
			this.channels[cID].members[uID] = vs;
			this.members[uID].voice_channel_id = cID;
		});
	
		//Now we can get rid of any of the things we don't need anymore
		delete(this.voice_states);
		delete(this.presences);
	}
	toString() {
		return `[object Guild]`;
	}
	get member_count() {
		return Object.keys(this.members).length;
	}
	hasMember(member) {
		return member.id in this.members;
	}
	addMember(client, data) {
		return this.members[data.user.id] = new Member(client, this, data);
	}
	updateMember(client, data) {
		if (!this.members[data.user.id]) return this.addMember(client, data);
		return this.members[data.user.id].update(data);
	}
	removeMember(client, data) {
		var member = this.members[data.user.id];
		delete(this.members[data.user.id]);
		return member;
	}
	hasChannel(channel) {
		return channel.id in this.channels;
	}
	addChannel(client, data) {
		if (this.hasChannel(data)) {
			return this.updateChannel(data);
		}
		var channel = client.channels[data.id] = new Channel(this, data);
		Object.defineProperty(this.channels, channel.id, {
			get: function() { return client.channels[channel.id]; },
			set: function(v) { client.channels[channel.id] = v; },
			enumerable: true,
			configurable: true
		});
		return channel;
	}
	updateChannel(client, data) {
		if (!this.hasChannel(data)) {
			return this.addChannel(client, data);
		}
		return this.channels[data.id].update(client, data);
	}
	removeChannel(client, data) {
		var channel = this.channels[data.id];
		if (channel) {
			Object.keys(this.members).forEach(memberID => {
				if (this.members[memberID].voice_channel_id == channel.id) {
					this.members[memberID].voice_channel_id = null;
				}
			});
			delete(this.channels[data.id]);
		}
		return channel;
	}
	hasRole(role) {
		return role.id in this.roles;
	}
	addRole(client, role) {
		if (this.hasRole(role)) {
			return this.updateRole(client, role);
		}
		return this.roles[role.id] = new Role(role);
	}
	updateRole(client, role) {
		if (!this.hasRole(role)) {
			return this.addRole(data);
		}
		return this.roles[data.role.id].update(data);
	}
	removeRole(client, data) {
		var role = this.roles[data.role_id];
		if (role) delete(this.roles[role.id]);
		return role;
	}
	hasEmoji(emoji) {
		return emoji.id in this.emoji;
	}
	addEmoji(client, data) {
		return this.emojis[data.id] = new Emoji(data);
	}
	updateEmoji(client, data) {
		// data is an array; this overwrites all the emoji objects
		this.emojis = {};
		data.forEach(emoji => {
			this.emojis[emoji.id] = new Emoji(emoji);
		});
		return this.emojis;
	}
	removeEmoji(client, data) {
		var emoji = this.emojis[data.id];
		if (emoji) delete(this.emojis[data.id]);
		return emoji;
	}
	colorFromRole(roles) {
		return roles.reduce((array, ID) => {
			var role = this.roles[ID];
			if (!role) return array;
			return role.position > array[0] && role.color ? [role.position, role.color] : array;
		}, [-1, null])[1];
	}
	update(data) {
		for (var key in data) {
			switch (key) {
				case 'roles':
					data[key].forEach(r => this.addRole(r));
					break;
				case 'emojis':
					// emojis are updated separately
					break;
				default:
					this[key] = data[key];
			}
		}
		return this;
	}
	syncMembers(client, members, presences) {
		if (!this.members) this.members = {};
		members.forEach(function(member) {
			var uID = member.user.id;
			if (!client.users[uID]) User.create(this, member.user);
			this.members[uID] = new Member(client, this, member);
		});
		if (presences) {
			//if (!this.presences) this.presences = {};
			presences.forEach(function(presence) {
				var uID = presence.user.id;
				if (!this.hasMember(presence.user))
					return void(new User(presence.user));
				delete(presence.user);
				copyKeys(presence, this.members[uID]);
			});
		}
		return this.members;
	}
	static create(client, data) {
		/*The lib will attempt to create the server using the response from the
		REST API, if the user using the lib creates the server. There are missing keys, however.
		So we still need this GUILD_CREATE event to fill in the blanks.
		If It's not our created server, then there will be no server with that ID in the cache,
		So go ahead and create one.*/
		if (client.servers[data.id]) return client.servers[data.id].update(data);
		return client.servers[data.id] = new Guild(client, data);
	}
	static update(client, data) {
		var server = client.servers[data.id];
		if (!server) return Guild.create(client, data);
		return server.update(data);
	}
	static delete(client, data) {
		var server = client.servers[data.id];
		if (server) delete(client.servers[data.id]);
		return server;
	}
	static sync(client, data) {
		var server = client.servers[data.id];
		server.syncMembers(client, data.members, data.presences);
		if ('large' in data) {
			server.large = data.large;
		}
		return server;
	}
}
class Channel extends Resource {
	constructor(server, data) {
		super();

		this.members = {};
		this.permissions = { user: {}, role: {} };
		this.guild_id = server.id;
		copyKeys(data, this, ['permission_overwrites', 'emojis']);
		data.permission_overwrites.forEach(function(p) {
			var type = (p.type === 'member' ? 'user' : 'role');
			this.permissions[type][p.id] = {allow: p.allow, deny: p.deny};
		}, this);

		//applyProperties(this, [
		//	['guild', server]
		//]);

		delete(this.is_private);
	}
	toString() {
		return `<#${this.id}>`;
	}
	addToGuild(server) {
		server.channels[this.id] = this;
	}
	removeFromGuild(server) {
		delete(server.channels[this.id]);
		return this;
	}
	update(client, data) {
		for (var key in data) {
			if (key === 'permission_overwrites') {
				data[key].forEach(function(p) {
					var type = (p.type === 'member' ? 'user' : 'role');
					client.channels[data.id].permissions[type][p.id] = {
						allow: p.allow,
						deny: p.deny
					};
				});
				continue;
			}
			client.channels[data.id][key] = data[key];
		}
	}
	static create(client, data) {
		var server = client.servers[data.guild_id];
		return server.addChannel(client, data);
	}
	static update(client, data) {
		var server = client.servers[data.guild_id];
		return server.updateChannel(client, data);
	}
	static delete(client, data) {
		var server = client.servers[data.guild_id];
		return server.removeChannel(client, data);
	}
}
class DMChannel extends Resource {
	constructor(client, data) {
		super(data);
		if (data.recipient_id) {
			client._uIDtoDM[data.recipient_id] = data.id;
		}
		this.recipient = data.recipients[0];
		data.recipients.forEach(function(user) {
			client._uIDtoDM[user.id] = data.id;
		});

		delete(this.is_private);
	}
	toString() {
		return `[object DMChannel]`;
	}
	update(data) {
		copyKeys(data, this);
		return this;
	}
	static create(client, data) {
		if (client.directMessages[data.id]) {
			return this.update(client, data);
		}
		return client.directMessages[data.id] = new DMChannel(client, data);
	}
	static update(client, data) {
		if (!client.directMessages[data.id]) {
			return this.create(client, data);
		}
		return client.directMessages[data.id].update(data);
	}
	static delete(client, data) {
		var channel = client.directMessages[data.id];
		if (channel) {
			delete(client.directMessages[data.id]);
			delete(client._uIDToDM[data.recipients[0].id]);
		}
		return channel;
	}
}
class User extends Resource {
	constructor(data) {
		super(data);
		this.bot = this.bot || false;
	}
	toString() {
		return `<@${this.id}>`;
	}
	get avatarURL() {
		if (!this.avatar) return null;
		var animated = this.avatar.startsWith("a_");
		return Discord.Endpoints.CDN + "/avatars/" + this.id + "/" + this.avatar + (animated ? ".gif" : ".webp");
	}
	update(data) {
		copyKeys(data, this);
		return this;
	}
	static create(client, data) {
		if (data.id == client.id) {
			copyKeys(data, client);
			return client;
		}
		if (client.users[data.id]) {
			return this.update(client, data);
		}
		return client.users[data.id] = new User(data);
	}
	static update(client, data) {
		if (data.id == client.id) {
			copyKeys(data, client);
			return client;
		}
		if (!client.users[data.id]) {
			return this.create(client, data);
		}
		return client.users[data.id].update(data);
	}
	static delete(client, data) {
		if (data.id == client.id) {
			// what?
			throw new Error('Cannot delete client\'s user object');
		}
		var user = client.users[data.id];
		if (user) delete(client.users[data.id]);
		return user;
	}
}
class Member extends Resource {
	constructor(client, server, data) {
		super(data, ['user', 'joined_at',]);
		this.id = data.user.id;
		this.joined_at = Date.parse(data.joined_at);
		['username', 'discriminator', 'bot', 'avatar', 'game'].forEach(k => {
			if (k in Member.prototype) return;
	
			Object.defineProperty(Member.prototype, k, {
				get: function() { return client.users[this.id][k]; },
				set: function(v) { client.users[this.id][k] = v; },
				enumerable: true,
			});
		});
		applyProperties(this, [
			['guild', server]
		]);
	}
	toString() {
		return `<@!${this.id}>`;
	}
	get color() {
		return this.guild.colorFromRole(this.roles);
	}
	isInGuild(server) {
		return this.id in server.members;
	}
	addToGuild(server) {
		return server.members[this.id] = this;
	}
	removeFromGuild(server) {
		return delete(server.members[this.id]), this;
	}
	hasRole(role) {
		return this.roles.includes(role.id);
	}
	addRole(role) {
		if (this.hasRole(role)) return;
		this.roles.push(role.id);
		return this;
	}
	removeRole(role) {
		if (!this.hasRole(role)) return;
		this.roles.splice(this.roles.indexOf(role.id), 1);
		return this;
	}
	update(data) {
		copyKeys(data, this, ['user']);
		return this;
	}
	static create(client, data) {
		var server = client.servers[data.guild_id];
		return server.addMember(client, data);
	}
	static update(client, data) {
		var server = client.servers[data.guild_id];
		return server.updateMember(client, data);
	}
	static delete(client, data) {
		var server = client.servers[data.guild_id];
		return server.removeMember(client, data);
	}
}
class Role extends Resource {
	constructor(data) {
		super(data, ['permissions']);
		//Use `permissions` from Discord, or `_permissions` if we're making it out of a cache.
		this._permissions = data._permissions || data.permissions;
	}
	toString() {
		return `<@&${this.id}>`;
	}
	get permission_values() {
		return this;
	}
	addToGuild(server) {
		return server.roles[this.id] = this;
	}
	removeFromGuild(server) {
		return delete(server.roles[this.id]), this;
	}
	addToMember(member) {
		member.addRole(this);
		return this;
	}
	removeFromMember(member) {
		member.removeRole(this);
		return this;
	}
	update(data) {
		this._permissions = data.role.permissions;
		copyKeys(data.role, this, ['permissions']);
		return this;
	}
	static create(client, data) {
		var server = client.servers[data.guild_id];
		return server.addRole(client, data);
	}
	static update(client, data) {
		var server = client.servers[data.guild_id];
		return server.updateRole(client, data);
	}
	static delete(client, data) {
		var server = client.servers[data.guild_id];
		return server.removeRole(client, data);
	}
}
class Emoji extends Resource {
	toString() {
		return `<:${this.name}:${this.id}>`;
	}
	addToGuild(server) {
		return server.emojis[this.id] = this;
	}
	removeFromGuild(server) {
		return delete(server.emojis[this.id]), this;
	}
	static create(client, data) {
		var server = client.servers[data.guild_id];
		return server.addEmoji(client, data);
	}
	static update(client, data) {
		var server = client.servers[data.guild_id];
		return server.updateEmoji(client, data);
	}
	static delete(client, data) {
		var server = client.servers[data.guild_id];
		return server.removeEmoji(client, data);
	}
}

/* - Discord Classes - Multipart Form - */
class Multipart {
	constructor() {
		this.boundary =
			"NodeDiscordIO" + "-" + CURRENT_VERSION;
		this.result = "";
	}
	append(data) {
		/* Header */
		var str = "\r\n--";
		str += this.boundary + "\r\n";
		str += 'Content-Disposition: form-data; name="' + data[0] + '"';
		if (data[2]) {
			str += '; filename="' + data[2] + '"\r\n';
			str += 'Content-Type: application/octet-stream';
		}
		/* Body */
		str += "\r\n\r\n" + ( data[1] instanceof Buffer ? data[1] : new Buffer(String(data[1]), 'utf-8') ).toString('binary');
		this.result += str;
	}
	finalize() {
		this.result += "\r\n--" + this.boundary + "--";
	}
}
/* - Discord Classes - Audio & Voice - */
class VoiceSession {
	constructor(server, channelID) {
		this.serverID = (server && server.id) || null;
		this.channelID = channelID;
		this.token = null;
		this.session = null;
		this.endpoint = null;
		this.self_mute = false;
		this.self_deaf = false;
	}
	initKeepAlive(vData) {
		this.wsKeepAlive = setInterval(send, vData.d.heartbeat_interval, this.ws.connection, { "op": Discord.Codes.Voice.HEARTBEAT, "d": null });
	}
	prepareToSend(vData) {
		this.selectedMode = vData.d.mode;
		this.secretKey    = vData.d.secret_key;
		this.joined       = true;
		this.ready        = true;
	}
	receiveSpeaking(vData) {
		this.emitter.emit('speaking', vData.d.user_id, vData.d.ssrc, vData.d.speaking);
	}
}
class AudioCB extends Stream.Duplex {
	constructor(voiceSession, audioChannels, encoder, maxStreamSize) {
		//With the addition of the new Stream API, `playAudioFile`, `stopAudioFile` and `send`
		//will be removed. However they're deprecated for now, hence the code repetition.
		if (maxStreamSize && !Opus) Opus = require('cjopus');
		super();

		this.audioChannels = audioChannels;
		this.members = voiceSession.members;

		applyProperties(this, [
			["_sequence", 0],
			["_timestamp", 0],
			["_readable", false],
			["_streamRef", null],
			["_startTime", null],
			["_systemEncoder", null],
			["_playingAudioFile", false],
			["_voiceSession", voiceSession],
			["_port", voiceSession.ws.port],
			["_address", voiceSession.address],
			["_decodeNonce", new Uint8Array(24)],
			["_vUDP", voiceSession.udp.connection],
			["_secretKey", new Uint8Array(voiceSession.secretKey)],
			["_mixedDecoder", Opus && new Opus.OpusEncoder( 48000, audioChannels ) || null]
		]);

		createAudioEncoder(this, encoder);

		this._write = (chunk, encoding, callback) => {
			this._systemEncoder.stdin.write(chunk);
			return callback();
		};
		this._read = () => {};
		this.stop = () => {
			return this._systemEncoder.stdout.read = () => null;
		};

		if (maxStreamSize) {
			// read incoming voice packets
			voiceSession.ws.connection.on('message', (data, flags) => {
				data = decompressWSMessage(data, flags);

				if (data.op !== Discord.Codes.Voice.SPEAKING) return;
				if (!voiceSession.members[data.d.user_id]) {
					voiceSession.members[data.d.user_id] = new Stream.Readable({
						highWaterMark: maxStreamSize,
						read: function(s) {}
					});
					voiceSession.members[data.d.user_id].decoder = new Opus.OpusEncoder( 48000, this.audioChannels );
					this.emit('newMemberStream', data.d.user_id, voiceSession.members[data.d.user_id]);
				}

				voiceSession.members[data.d.user_id].ssrc = data.d.ssrc;
				voiceSession.translator[data.d.ssrc] = voiceSession.members[data.d.user_id];
			});
			this._vUDP.on('message', this.handleIncomingAudio.bind(this));
		}

		this._done = false;
	}

	//TODO: Remove in v3
	playAudioFile(location, callback) {
		if (!this._mixedDecoder) {
			if (!Opus) Opus = require('cjopus');
			this._mixedDecoder = new Opus.OpusEncoder( 48000, this.audioChannels );
		}

		if (this._playingAudioFile) return handleErrCB("There is already a file being played.", callback);
		var encs = ['ffmpeg', 'avconv'], selection, enc;

		this._playingAudioFile = true;
		selection = this.chooseAudioEncoder(encs);

		if (!selection) return console.log("You need either 'ffmpeg' or 'avconv' and they need to be added to PATH");

		enc = ChildProc.spawn(selection , [
			'-i', location,
			'-f', 's16le',
			'-ar', '48000',
			'-ac', this.audioChannels,
			'pipe:1'
		], {stdio: ['pipe', 'pipe', 'ignore']});
		enc.stdout.once('end', () => {
			enc.kill();
			send(this._voiceSession.ws.connection, Payloads.VOICE_SPEAK(0));
			this._playingAudioFile = false;
			this.emit('fileEnd');
		});
		enc.stdout.once('error', e => {
			enc.stdout.emit('end');
		});
		enc.stdout.once('readable', () => {
			send(this._voiceSession.ws.connection, Payloads.VOICE_SPEAK(1));
			this._startTime = new Date().getTime();
			this.prepareAudioOld(enc.stdout, 1);
		});
		this._streamRef = enc;
	}

	//TODO: Remove in v3
	stopAudioFile(callback) {
		if (!this._playingAudioFile) return handleErrCB("There is no file being played", callback);

		this._streamRef.stdout.end();
		this._streamRef.kill();
		this._playingAudioFile = false;

		call(callback);
	}

	//TODO: Remove in v3
	send(stream) {
		if (!this._mixedDecoder) {
			if (!Opus) Opus = require('cjopus');
			this._mixedDecoder = new Opus.OpusEncoder( 48000, this.audioChannels );
		}
		send(this._voiceSession.ws.connection, Payloads.VOICE_SPEAK(1));
		this._startTime = new Date().getTime();
		this.prepareAudioOld(stream, 1);
	}

	prepareAudio(readableStream, cnt) {
		var data = readableStream.read( 320 ) || readableStream.read(); //(128 [kb] * 20 [frame_size]) / 8 == 320
	
		if (!data) {
			send(this._voiceSession.ws.connection, Payloads.VOICE_SPEAK(0));
			this._readable = false;
			return readableStream.emit('end');
		}

		return setTimeout(() => {
			this.sendAudio(data);
			this.prepareAudio(stream, cnt + 1);
		}, 20 + ( (this._startTime + cnt * 20) - Date.now() ));
	}
	//TODO: Remove in v3
	prepareAudioOld() {
		var done = false;

		readableStream.on('end', () => {
			done = true;
			send(this._voiceSession.ws.connection, Payloads.VOICE_SPEAK(0));
		});

		var ACBI = this;
		_prepareAudio(1);

		function _prepareAudio(cnt) {
			if (done) return;
			var buffer, encoded;
	
			buffer = readableStream.read( 1920 * ACBI.audioChannels );
			encoded = [0xF8, 0xFF, 0xFE];
	
			if ((buffer && buffer.length === 1920 * ACBI.audioChannels) && !ACBI._mixedDecoder.destroyed) {
				encoded = ACBI._mixedDecoder.encode(buffer);
			}
	
			return setTimeout(() => {
				ACBI.sendAudio(encoded);
				_prepareAudio(cnt + 1);
			}, 20 + ( (ACBI._startTime + cnt * 20) - Date.now() ));
		}
	}

	sendAudio(buffer) {
		this._sequence  = (this._sequence  + 1  ) < 0xFFFF     ? this._sequence  + 1   : 0;
		this._timestamp = (this._timestamp + 960) < 0xFFFFFFFF ? this._timestamp + 960 : 0;
		if (this._voiceSession.self_mute) return;
		var audioPacket = AudioCB.VoicePacket(buffer, this._voiceSession.ws.ssrc, this._sequence, this._timestamp, this._secretKey);
	
		try {
			//It throws a synchronous error if it fails (someone leaves the audio channel while playing audio)
			this._vUDP.send(audioPacket, 0, audioPacket.length, this._port, this._address);
		} catch(e) { return; }
	}
	
	handleIncomingAudio(msg) {
		//The response from the UDP keep alive ping
		if (msg.length === 8 || this._voiceSession.self_deaf) return;
	
		var header = msg.slice(0, 12),
			audio = msg.slice(12),
			ssrc = header.readUIntBE(8, 4),
			member = this._voiceSession.translator[ssrc],
			decrypted, decoded;
	
		this._decodeNonce.set(header);

		try {
			decrypted = new Buffer(
				NACL.secretbox.open(
					new Uint8Array(audio),
					this._decodeNonce,
					this._secretKey
				)
			);

			if (member) {
				decoded = member.decoder.decode(decrypted);
				this.addToStreamBuffer(member, decoded);
			} else {
				decoded = this._mixedDecoder.decode(decrypted);
			}

			this.addToStreamBuffer(this, decoded);
			this.emit('incoming', ssrc, decoded );
		} catch(e) {}
	}
	addToStreamBuffer(RStream, data) {
		return RStream.push(new Buffer(data)) || !!RStream.read(data.length);
	}
	chooseAudioEncoder(players) {
		var encoder, selected = null;
		while (players.length && !selected) {
			encoder = ChildProc.spawnSync(players.shift());
			if (!encoder.error) selected = encoder.file;
		}
		return selected;
	}
	createAudioEncoder(encoder) {
		var enc = this._systemEncoder;
		if (enc) {
			enc.stdout.emit('end');
			enc.kill();
			this._systemEncoder = null;
		}
	
		enc = this._systemEncoder = ChildProc.spawn(encoder, [
			'-hide_banner',
			'-loglevel', 'error',
			'-i', 'pipe:0',
			'-map', '0:a',
			'-acodec', 'libopus',
			'-f', 'data',
			'-sample_fmt', 's16',
			'-vbr', 'off',
			'-compression_level', '10',
			'-ar', '48000',
			'-ac', this.audioChannels,
			'-b:a', '128000',
			'pipe:1'
		], {stdio: ['pipe', 'pipe', 'pipe']});
	
		enc.stderr.once('data', d => {
			if (this.listeners('error').length > 0) this.emit('error', d.toString());
		});
		enc.stdin.once('error', e => {
			enc.stdout.emit('end');
			enc.kill();
		});
		enc.stdout.once('error', e => {
			enc.stdout.emit('end');
			enc.kill();
		});
		enc.stdout.once('end', () => {
			this.createAudioEncoder(encoder);
			this.emit('done');
		});
		enc.stdout.on('readable', () => {
			if (this._readable) return;
	
			this._readable = true;
			send(this._voiceSession.ws.connection, Payloads.VOICE_SPEAK(1));
			this._startTime = new Date().getTime();
			this.prepareAudio(enc.stdout, 1);
		});
	}
	static VoicePacket(packet, ssrc, sequence, timestamp, key) {
		this.header.writeUIntBE(sequence, 2, 2);
		this.header.writeUIntBE(timestamp, 4, 4);
		this.header.writeUIntBE(ssrc, 8, 4);
		//<Buffer 80 78 00 01 00 00 03 c0 00 00 00 01>
		this.nonce.set(this.header);
		//<Buffer 80 78 00 01 00 00 03 c0 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00>

		var encrypted = new Buffer(
			NACL.secretbox(
				new Uint8Array(packet),
				this.nonce,
				key
			)
		);

		this.header.copy(this.output);
		encrypted.copy(this.output, 12);

		return this.output.slice(0, this.header.length + encrypted.length);
	}
}

(function () {
	applyProperties(AudioCB, [
		['header', new Buffer(12)],
		['nonce',  new Uint8Array(24)],
		['output', new Buffer(2048)]
	]);
	AudioCB.header[0] = 0x80;
	AudioCB.header[1] = 0x78;
})();

/* --- Functions --- */
function handleErrCB(err, callback) {
	if (!err) return false;
	return call(callback, [new Error(err)]);
}
function handleResCB(errMessage, err, res, callback) {
	if (typeof(callback) !== 'function') return;
	res = res || {};
	if (!err && goodResponse(res)) return (callback(null, res.body), true);

	var e = new Error( err || errMessage );
	e.name = "ResponseError";
	e.statusCode = res.statusCode;
	e.statusMessage = res.statusMessage;
	e.response = res.body;
	return (callback(e), false);
}
function goodResponse(response) {
	return (response.statusCode / 100 | 0) === 2;
}
function stringifyError(response) {
	if (!response) return null;
	return response.statusCode + " " + response.statusMessage + "\n" + JSON.stringify(response.body);
}

function messageHeaders(client) {
	var r = {
		"accept": "*/*",
		"accept-language": "en-US;q=0.8",
	};
	if (isNode) {
		r["accept-encoding"] = "gzip, deflate";
		r.user_agent = "DiscordBot (https://github.com/izy521/discord.io, " + CURRENT_VERSION + ")";
		r.dnt = 1;
	}
	try {
		r.authorization = (client.bot ? "Bot " : "") + client.internals.token;
	} catch(e) {}
	return r;
}
function stringifyEmoji(emoji) {
	if (typeof emoji === 'object') // if (emoji.name && emoji.id)
		return emoji.name + ':' + emoji.id;
	if (emoji.indexOf(':') > -1)
		return emoji;
	return encodeURIComponent(decodeURIComponent(emoji));
}

/* - Functions - Utils */
function APIRequest(method, url) {
	var data, callback, opts, req, headers = messageHeaders(this);
	callback = ( typeof(arguments[2]) === 'function' ? arguments[2] : (data = arguments[2], arguments[3]) );

	if (isNode) {
		opts = URL.parse(url);
		opts.method = method;
		opts.headers = headers;

		req = requesters[opts.protocol.slice(0, -1)].request(opts, function(res) {
			var chunks = [];
			res.on('data', function(c) { chunks[chunks.length] = c; });
			res.once('end', function() {
				chunks = Buffer.concat(chunks);
				Zlib.gunzip(chunks, function(err, uc) {
					if (!err) uc = uc.toString();
					try { res.body = JSON.parse(uc || chunks); } catch(e) {}
					return callback(null, res);
				});
			});
		});
		if (type(data) === 'object' || method.toLowerCase() === 'get') req.setHeader("Content-Type", "application/json; charset=utf-8");
		if (data instanceof Multipart) req.setHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
		if (data) req.write( data.result || JSON.stringify(data), data.result ? 'binary' : 'utf-8' );
		req.end();

		return req.once('error', function(e) { return callback(e.message); });
	}

	req = new XMLHttpRequest();
	req.open(method.toUpperCase(), url, true);
	for (var key in headers) {
		req.setRequestHeader(key, headers[key]);
	}
	req.onreadystatechange = function() {
		if (req.readyState == 4) {
			req.statusCode = req.status;
			req.statusMessage = req.statusText;
			try {req.body = JSON.parse(req.responseText);} catch (e) { return handleErrCB(e, callback); }
			callback(null, req);
		}
	};
	if (type(data) === 'object' || method.toLowerCase() === 'get') req.setRequestHeader("Content-Type", "application/json; charset=utf-8");
	if (data instanceof Multipart) req.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
	if (data) return req.send( data.result ? data.result : JSON.stringify(data) );
	req.send(null);
}
function send(ws, data) {
	if (ws && ws.readyState == 1) ws.send(JSON.stringify(data));
}
function copy(obj) {
	try {
		return JSON.parse( JSON.stringify( obj ) );
	} catch(e) {}
}
function copyKeys(from, to, omit) {
	if (!omit) omit = [];
	for (var key in from) {
		if (omit.indexOf(key) > -1) continue;
		to[key] = from[key];
	}
}
function applyProperties(object, properties) {
	properties.forEach(function(t) {
		Object.defineProperty(object, t[0], {
			configurable: true,
			writable: true,
			value: t[1]
		});
	}, object);
}
function type(v) {
	return Object.prototype.toString.call(v).match(/ (.*)]/)[1].toLowerCase();
}
function call(f, a) {
	if (typeof(f) != 'function') return;
	return f.apply(null, a);
}
function qstringify(obj) {
	//.map + .join is 7x slower!
	var i=0, s = "", k = Object.keys(obj);
	for (i;i<k.length;i++) {
		s += k[i] + "=" + obj[k[i]] + "&";
	}
	return "?" + s.slice(0, -1);
}
function toCamelCase(string) {
	var t = string.split("_"), i = 1, str = t[0].toLowerCase();
	for (var i = 1; i < t.length; i++) {
		str += t[i][0] + t[i].slice(1).toLowerCase();
	}
	return str;
}
function emit(client, message) {
	if (!message.t) return;
	var args = [toCamelCase(message.t)];
	for (var i = 2; i < arguments.length; i++) {
		args.push(arguments[i]);
	}
	args.push(message);
	client.emit.apply(client, args);
}
function decompressWSMessage(m, f = {}) {
	return f.binary ? JSON.parse(Zlib.inflateSync(m).toString()) : JSON.parse(m);
}
function removeAllListeners(emitter, type) {
	if (!emitter) return;
	var e = emitter._evts, i, k, o, s, z;
	if (isNode) return type ? emitter.removeAllListeners(type) : emitter.removeAllListeners();

	if (type && e[type]) {
		for (i=0; i<e[type].length; i++) {
			emitter.removeListener(type, e[type][i]);
		}
	}

	if (!type) {
		k = Object.keys(e);
		for (o=0; o<k.length; o++) {
			s = e[ k[o] ];
			for (z=0; z<s.length; z++) {
				emitter.removeListener(k[o], s[z]);
			}
		}
	}
}
function log(client, level_message) {
	var level, message;
	if (arguments.length === 2) {
		level = Discord.LogLevels.Info;
		message = level_message;
	} else {
		level = level_message;
		message = arguments[2];
	}
	return client.emit('log', level, message);
}
// Permissions
function givePermission(bit, permissions) {
	return permissions | (1 << bit);
}
function removePermission(bit, permissions) {
	return permissions & ~(1 << bit);
}
function hasPermission(bit, permissions) {
	return ((permissions >> bit) & 1) == 1;
}
//For the Getters and Setters
function getPerm(bit) {
	return function() {
		return ((this._permissions >> bit) & 1) == 1;
	};
}
function setPerm(bit) {
	return function(v) {
		if (v === true) return this._permissions |= (1 << (bit));
		if (v === false) return this._permissions &= ~(1 << bit);
	};
}
function resolveEvent(e) {
	return e.detail || ([e.data][0] ? [e.data] : [e.code]);
}
// Other
function keepUDPAlive(VS) {
	if (!VS.keepAliveBuffer) return;

	if (VS.keepAlivePackets > 4294967294) {
		VS.keepAlivePackets = 0;
		VS.keepAliveBuffer.fill(0);
	}
	VS.keepAliveBuffer.writeUIntLE(++VS.keepAlivePackets, 0, 6);
	try {
		return VS.udp.connection.send(VS.keepAliveBuffer, 0, VS.keepAliveBuffer.length, VS.ws.port, VS.address);
	} catch(e) {}
}

/* Discord - Packaging it all together */

//Discord.OAuth;
Discord.version = CURRENT_VERSION;
Discord.Emitter      = EventEmitter;
Discord.EventEmitter = EventEmitter;
Discord.Websocket    = Websocket;

Discord.Client    = DiscordClient;
Discord.Message   = Message;
Discord.Guild     = Guild;
Discord.Member    = Member;
Discord.Role      = Role;
Discord.Emoji     = Emoji;
Discord.DMChannel = DMChannel;
Discord.User      = User;

Discord.Codes = {};
Discord.Codes.Gateway = {
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	STATUS_UPDATE: 3,
	VOICE_STATUS_UPDATE: 4,
	RESUME: 6,
	RECONNECT: 7,
	REQUEST_GUILD_MEMBERS: 8,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11
};
Discord.Codes.WebSocket = {
	"0"   : "Gateway Error",
	"4000": "Unknown Error",
	"4001": "Unknown Opcode",
	"4002": "Decode Error",
	"4003": "Not Authenticated",
	"4004": "Authentication Failed",
	"4005": "Already Authenticated",
	"4006": "Session Not Valid",
	"4007": "Invalid Sequence Number",
	"4008": "Rate Limited",
	"4009": "Session Timeout",
	"4010": "Invalid Shard",
	"4011": "Sharding Required",
	"4012": "Invalid Gateway Version"
};
Discord.Codes.Voice = {
	IDENTIFY: 0,
	SELECT_PROTOCOL: 1,
	READY: 2,
	HEARTBEAT: 3,
	SESSION_DESCRIPTION: 4,
	SPEAKING: 5,
	HEARTBEAT_ACK: 6,
	RESUME: 7,
	HELLO: 8,
	RESUMED: 9,
	CLIENT_DISCONNECT: 13
};
Discord.Codes.VoiceClose = {
	"4001": "Unknown Opcode",
	"4003": "Not Authenticated",
	"4004": "Authentication Failed",
	"4005": "Already Authenticated",
	"4006": "Session Not Valid",
	"4009": "Session Timeout",
	"4011": "Server Not Found",
	"4012": "Unknown Protocol",
	"4014": "Disconnected",
	"4015": "Voice Server Crashed",
	"4016": "Unknown Encryption Mode"
};
Discord.Colors = {
	DEFAULT: 0,
	AQUA: 1752220,
	GREEN: 3066993,
	BLUE: 3447003,
	PURPLE: 10181046,
	GOLD: 15844367,
	ORANGE: 15105570,
	RED: 15158332,
	GREY: 9807270,
	DARKER_GREY: 8359053,
	NAVY: 3426654,
	DARK_AQUA: 1146986,
	DARK_GREEN: 2067276,
	DARK_BLUE: 2123412,
	DARK_PURPLE: 7419530,
	DARK_GOLD: 12745742,
	DARK_ORANGE: 11027200,
	DARK_RED: 10038562,
	DARK_GREY: 9936031,
	LIGHT_GREY: 12370112,
	DARK_NAVY: 2899536
};
Discord.Permissions = {
	GENERAL_CREATE_INSTANT_INVITE: 0,
	GENERAL_KICK_MEMBERS: 1,
	GENERAL_BAN_MEMBERS: 2,
	GENERAL_ADMINISTRATOR: 3,
	GENERAL_MANAGE_CHANNELS: 4,
	GENERAL_MANAGE_GUILD: 5,
	GENERAL_AUDIT_LOG: 7,
	VOICE_PRIORITY_SPEAKER: 8,
	GENERAL_MANAGE_ROLES: 28,
	GENERAL_MANAGE_NICKNAMES: 27,
	GENERAL_CHANGE_NICKNAME: 26,
	GENERAL_MANAGE_WEBHOOKS: 29,
	GENERAL_MANAGE_EMOJIS: 30,

	TEXT_ADD_REACTIONS: 6,
	TEXT_READ_MESSAGES: 10,
	TEXT_SEND_MESSAGES: 11,
	TEXT_SEND_TTS_MESSAGE: 12,
	TEXT_MANAGE_MESSAGES: 13,
	TEXT_EMBED_LINKS: 14,
	TEXT_ATTACH_FILES: 15,
	TEXT_READ_MESSAGE_HISTORY: 16,
	TEXT_MENTION_EVERYONE: 17,
	TEXT_EXTERNAL_EMOJIS: 18,

	VOICE_CONNECT: 20,
	VOICE_SPEAK: 21,
	VOICE_MUTE_MEMBERS: 22,
	VOICE_DEAFEN_MEMBERS: 23,
	VOICE_MOVE_MEMBERS: 24,
	VOICE_USE_VAD: 25,
};
Discord.LogLevels = {
	Verbose: 0,
	Info: 1,
	Warn: 2,
	Error: 3
};
Discord.Events = {
	READY: "ready",
	MESSAGE_CREATE: "messageCreate",
	MESSAGE_UPDATE: "messageUpdate",
	PRESENCE_UPDATE: "presenceUpdate",
	USER_UPDATE: "userUpdate",
	USER_SETTINGS_UPDATE: "userSettingsUpdate",
	GUILD_CREATE: "guildCreate",
	GUILD_UPDATE: "guildUpdate",
	GUILD_DELETE: "guildDelete",
	GUILD_MEMBER_ADD: "guildMemberAdd",
	GUILD_MEMBER_UPDATE: "guildMemberUpdate",
	GUILD_MEMBER_REMOVE: "guildMemberRemove",
	GUILD_ROLE_CREATE: "guildRoleCreate",
	GUILD_ROLE_UPDATE: "guildRoleUpdate",
	GUILD_ROLE_DELETE: "guildRoleDelete",
	CHANNEL_CREATE: "channelCreate",
	CHANNEL_UPDATE: "channelUpdate",
	CHANNEL_DELETE: "channelDelete",
	GUILD_EMOJIS_UPDATE: "guildEmojisUpdate",
	VOICE_STATE_UPDATE: "voiceStateUpdate",
	VOICE_SERVER_UPDATE: "voiceServerUpdate",
	GUILD_MEMBERS_CHUNK: "guildMembersChunk",
	GUILD_SYNC: "guildSync"
};
Discord.ChannelTypes = {
	GUILD_TEXT: 0,
	DM: 1,
	GUILD_VOICE: 2,
	GROUP_DM: 3,
	GUILD_CATEGORY: 4
};
Discord.MessageTypes = {
	DEFAULT: 0,
	RECIPIENT_ADD: 1,
	RECIPIENT_REMOVE: 2,
	CALL: 3,
	CHANNEL_NAME_CHANGE: 4,
	CHANNEL_ICON_CHANGE: 5,
	CHANNEL_PINNED_MESSAGE: 6,
	GUILD_MEMBER_JOIN: 7
};
Discord.PresenceTypes = {
	PLAYING: 0,
	STREAMING: 1,
	LISTENING: 2,
	WATCHING: 3
};

Object.keys(Discord.Permissions).forEach(function(pn) {
	Object.defineProperty(Role.prototype, pn, {
		get: getPerm( Discord.Permissions[pn] ),
		set: setPerm( Discord.Permissions[pn] ),
		enumerable: true
	});
});

/* Endpoints */
(function () {
	var API = "https://discordapp.com/api";
	var CDN = "http://cdn.discordapp.com";
	var ME  = API + "/users/@me";
	Endpoints = Discord.Endpoints = {
		API: 		API,
		CDN: 		CDN,

		ME:			ME,
		NOTE:		function(userID) {
			return  ME + "/notes/" + userID;
		},
		LOGIN:		API + "/auth/login",
		OAUTH:		API + "/oauth2/applications/@me",
		GATEWAY:	API + "/gateway",
		SETTINGS: 	ME + "/settings",

		SERVERS: function(serverID) {
			return  API + "/guilds" + (serverID ? "/" + serverID : "");
		},
		SERVERS_PERSONAL: function(serverID) {
			return  this.ME + "/guilds" + (serverID ? "/" + serverID : ""); //Method to list personal servers?
		},
		SERVER_EMOJIS: function(serverID, emojiID) {
			return  this.SERVERS(serverID) + "/emojis" + (emojiID ? "/" + emojiID : "");
		},

		CHANNEL: function(channelID) {
			return  API + "/channels/" + channelID;
		},

		MEMBERS: function(serverID, userID) {
			return  this.SERVERS(serverID) + "/members" + (userID ? "/" + userID : "");
		},
		MEMBER_ROLES: function(serverID, userID, roleID) {
			return	this.MEMBERS(serverID, userID) + "/roles" + (roleID ? "/" + roleID : "");
		},

		USER: function(userID) {
			return  API + "/users/" + userID;
		},

		ROLES: function(serverID, roleID) {
			return  this.SERVERS(serverID) + "/roles" + (roleID ? "/" + roleID : "");
		},

		BANS: function(serverID, userID) {
			return  this.SERVERS(serverID) + "/bans" + (userID ? "/" + userID : "");
		},

		MESSAGES: function(channelID, messageID) {
			return  this.CHANNEL(channelID) + "/messages" + (messageID ? "/" + messageID : "");
		},
		PINNED_MESSAGES: function(channelID, messageID) {
			return  this.CHANNEL(channelID) + "/pins" + (messageID ? "/" + messageID : "");
		},

		MESSAGE_REACTIONS: function(channelID, messageID, reaction) {
			return  this.MESSAGES(channelID, messageID) + "/reactions" + ( reaction ? ("/" + reaction) : "" );
		},
		USER_REACTIONS: function(channelID, messageID, reaction, userID) {
		  	return  this.MESSAGE_REACTIONS(channelID, messageID, reaction) + '/' + ( (!userID || userID === this.id) ? '@me' : userID );
		},

		INVITES: function(inviteCode) {
			return  API + "/invite/" + inviteCode;
		},

		SERVER_WEBHOOKS: function(serverID) {
			return  this.SERVERS(serverID) + "/webhooks";
		},
		CHANNEL_WEBHOOKS: function(channelID) {
			return  this.CHANNEL(channelID) +"/webhooks";
		},

		WEBHOOKS: function(webhookID) {
			return  API + "/webhooks/" + webhookID;
		},

		BULK_DELETE: function(channelID) {
			return  this.CHANNEL(channelID) + "/messages/bulk-delete";
		},

		TYPING: function(channelID) {
			return  this.CHANNEL(channelID) + "/typing";
		}

	};
})();

/* Payloads */
(function() {
	Payloads = {
		IDENTIFY: function(client) {
			return {
				op: 2,
				d: {
					token: client.internals.token,
					v: GATEWAY_VERSION,
					compress: isNode && !!Zlib.inflateSync,
					large_threshold: LARGE_THRESHOLD,
					presence: client.presence,
					properties: {
						$os: isNode ? require('os').platform() : navigator.platform,
						$browser:"discord.io",
						$device:"discord.io",
						$referrer:"",
						$referring_domain:""
					}
				}
			};
		},
		RESUME: function(client) {
			return {
				op: 6,
				d: {
					token: client.internals.token,
					session_id: client.internals.sessionID,
					seq: client.internals.s || client.internals.sequence
				}
			};
		},
		HEARTBEAT: function(client) {
			return {op: 1, d: client.internals.sequence};
		},
		ALL_USERS: function(client) {
			return {op: 12, d: Object.keys(client.servers)};
		},
		STATUS: function(input) {
			return {
				op: 3,
				d: {
					status: type(input.since) === 'number' ? 'idle' : input.status !== undefined ? input.status : null,
					afk: !!input.afk,
					since: type(input.since) === 'number' || input.status === 'idle' ? Date.now() : null,
					game: type(input.game) === 'object' ?
						{
							name: input.game.name ? String(input.game.name) : null,
							type: input.game.type ? Number(input.game.type) : 0,
							url: input.game.url ? String(input.game.url) : null
						} :
						null
				}
			};
		},
		UPDATE_VOICE: function(serverID, channelID, self_mute, self_deaf) {
			return {
				op: 4,
				d: {
					guild_id: serverID,
					channel_id: channelID,
					self_mute: self_mute,
					self_deaf: self_deaf
				}
			};
		},
		OFFLINE_USERS: function(array) {
			return {
				op: 8,
				d: {
					guild_id: array.splice(0, 50),
					query: "",
					limit: 0
				}
			};
		},
		VOICE_SPEAK: function(v) {
			return {op:5, d:{ speaking: !!v, delay: 0 }};
		},
		VOICE_IDENTIFY: function(clientID, voiceSession) {
			return {
				op: 0,
				d: {
					server_id: voiceSession.serverID,
					user_id: clientID,
					session_id: voiceSession.session,
					token: voiceSession.token
				}
			};
		},
		VOICE_DISCOVERY: function(ip, port, mode) {
			return {
				op:1,
				d:{
					protocol:"udp",
					data:{
						address: ip,
						port: Number(port),
						mode: mode
					}
				}
			};
		}
	}
})();

})(typeof exports === 'undefined'? this.Discord = {} : exports);
