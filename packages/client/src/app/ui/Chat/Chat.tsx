import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { Contract } from "@canvas-js/core";
import { SIWESigner } from "@canvas-js/chain-ethereum";
import { useLiveQuery, useCanvas } from "@canvas-js/hooks";
import { useMUD } from "../../../useMUD";
import { useCurrentPlayer } from "../hooks/useCurrentPlayer";
import { Entity } from "@latticexyz/recs";
import { Wallet } from "ethers";
import { useCurrentTime } from "../../amalgema-ui/hooks/useCurrentTime";
import { DateTime } from "luxon";
import { useExternalAccount } from "../hooks/useExternalAccount";
import { getBurnerWallet } from "../../../mud/getBrowserNetworkConfig";
import { ClickWrapper } from "../Theme/ClickWrapper";
import { useAllPlayerDetails } from "../hooks/usePlayerDetails";
import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { randomBytes } from "@noble/hashes/utils";

type Message = { 
  id: string; 
  address: string; 
  content: string; 
  channel: string;
  color: string; 
  name: string;
  nonce: string;
  player: string;
  timestamp: number 
};

type Player = { 
  id: string;
  address: string;
  key: string;
  player: string
};

enum CHANNELS {
  ALL = 'All',
  PLAYER = 'Player'
}

const createContract = (matchEntity: Entity) => {
  const contract = {
    topic: `${matchEntity}.canvas.xyz`,
    models: {
      message: {
        id: "primary",
        address: "string",
        name: "string",
        color: "string",
        content: "string",
        nonce: "string",
        timestamp: "integer",
        player: "string",
        channel: "string", // if CHANNELS.Player, messages in 'content' field will be encrypted ciphertext
        $indexes: ["user", "timestamp"],
      },
      players: {
        id: "primary",
        address: "string",
        player: "string",
        key: "string"
      },
    },

    actions: {
      async createMessage(db, { content, name, color, channel, player, nonce }, { id, address, timestamp }) {
        await db.set("message", { id, address, content, name, color, timestamp, channel, player, nonce });
      },

      async createPlayer(db, { key, player }, { id, address }) {
        await db.set("players", { id, address, key, player });
      },
    },
  } as Contract;

  return contract;
};

export function Chat() {
  const {
    networkLayer: {
      components: { Name },
      network: { matchEntity },
      utils: { sendAnalyticsEvent },
    },
    phaserLayer: {
      api: {
        mapInteraction: { disableMapInteraction, enableMapInteraction },
      },
    },
  } = useMUD();

  const externalWalletClient = useExternalAccount();
  const playerData = useAllPlayerDetails(matchEntity ?? ("" as Entity));
  const currentPlayer = useCurrentPlayer(matchEntity ?? ("" as Entity));

  const [otherPlayer, setOtherPlayer] = useState<Player | undefined>(undefined);
  const [ initialized, setInitialized ] = useState<boolean>(false);
  const [ channel, setChannel ] = useState<string>(CHANNELS.ALL);

  const randomWallet = useMemo(() => Wallet.createRandom(), []);
  const contract = useMemo(() => createContract(matchEntity ?? ("" as Entity)), [matchEntity]);
  const { app } = useCanvas({
    contract,
    indexHistory: false,
    discoveryTopic: "canvas-discovery",
    signers: [new SIWESigner({ signer: randomWallet })],
    bootstrapList: [
      "/dns4/canvas-chat-discovery-p0.fly.dev/tcp/443/wss/p2p/12D3KooWG1zzEepzv5ib5Rz16Z4PXVfNRffXBGwf7wM8xoNAbJW7",
      "/dns4/canvas-chat-discovery-p1.fly.dev/tcp/443/wss/p2p/12D3KooWNfH4Z4ayppVFyTKv8BBYLLvkR1nfWkjcSTqYdS4gTueq",
      "/dns4/canvas-chat-discovery-p2.fly.dev/tcp/443/wss/p2p/12D3KooWRBdFp5T1fgjWdPSCf9cDqcCASMBgcLqjzzBvptjAfAxN",
      "/dns4/peer.canvasjs.org/tcp/443/wss/p2p/12D3KooWFYvDDRpXtheKXgQyPf7sfK2DxS1vkripKQUS2aQz5529",
    ],
  });

  const players = useLiveQuery<Player>(app, "players", {
    orderBy: { address: "asc" },
  });

  /*
    We need to wait for Canvas to finish initializing and connecting to peers before we register encryption keys, so we wait for `app.status === 'connected'` before doing any loading stage operations
  */ 
  useEffect(() => {
    if (!app || app.status !== 'connected' || initialized) {
      return;
    }

    // check if user has registered an encryption key
    const sessionWalletPrivateKey = getBurnerWallet();
    const publicKey = new Wallet(sessionWalletPrivateKey).publicKey;

    const hasRegistrationKey = players?.some((player: Player) => {
      return (currentPlayer.player === player.player)
    });

    // if not, create one 
    if (!hasRegistrationKey) {
      app.actions.createPlayer({ key: publicKey, player: currentPlayer.player});
    }

    setInitialized(true);

  }, [app, app?.status, initialized, players])

  /* 
    We need to determine when another player has joined and is ready to start direct messaging. Two things here:

    1) `playerData` shows that another user has joined the match 
    2) `players` shows that user has joined and registered an encryption key
  */ 
  useEffect(() => {
    // if other player has been set already, return
    if (!!otherPlayer || !initialized) {
      return;
    }

    const pdPlayer = playerData.find((pd: any) => pd.player !== currentPlayer.player);

    if (!pdPlayer) {
      return;
    }

    // find pdPlayer's encryption key in the Canvas store 
    const pPlayer = players?.find((c: Player) => c.player === pdPlayer.player);

    if (!pPlayer) {
      return;
    }

    // if match player exist and key has been registered, set the otherPlayer state variable, which means we're ready for chatting
    setOtherPlayer({
      id: "N/A",
      address: "N/A",
      player: pdPlayer.player,
      key: pPlayer.key,
    });
  }, [playerData, players, otherPlayer, initialized])

  const now = useCurrentTime();
  const secondsVisibleAfterInteraction = 15;
  const [lastInteraction, setLastInteraction] = useState(DateTime.now());
  const [inputFocused, setInputFocused] = useState(false);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    disableMapInteraction("chat");
    setInputFocused(true);
    setLastInteraction(DateTime.now());
  }, [disableMapInteraction]);
  const blurInput = useCallback(() => {
    if (!inputFocused) return;

    inputRef.current?.blur();
    enableMapInteraction("chat");
    setInputFocused(false);
    setLastInteraction(DateTime.now());
  }, [enableMapInteraction, inputFocused]);

  const [newMessage, setNewMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollIntoViewRef = useRef<HTMLDivElement>(null);

  const messages = useLiveQuery<Message>(app, "message", {
    orderBy: { timestamp: "asc" },
  });

  useEffect(() => {
    setLastInteraction(DateTime.now());
    scrollIntoViewRef.current?.scrollIntoView();
  }, [messages]);

  useEffect(() => {
    if (lastInteraction.plus({ seconds: secondsVisibleAfterInteraction }).diff(now).milliseconds > 0) return;
    scrollIntoViewRef.current?.scrollIntoView();
  }, [blurInput, lastInteraction, now]);

  const getPlayerName = useCallback(() => {
    const currentPlayerData = playerData.find((pd: any) => pd.player === currentPlayer?.player);

    if (currentPlayerData) {
      return currentPlayerData.name;
    }

    // default to 'Spectator' if current player isn't found
    return 'Spectator';
  }, [currentPlayer, playerData]);

  const getEncryptedTextContent = ({ text }: { text: string }) => {
    const privKey = getBurnerWallet();
    const recipientKey = otherPlayer?.key;

    if (!recipientKey) return null;

    try {
      const sharedSecret = secp256k1.getSharedSecret(privKey.slice(2), recipientKey.slice(2));

      const aesKey = sha256(sharedSecret);
      const nonce = randomBytes(24);
      const aesAlgo = gcm(aesKey, nonce);
      const ciphertext = aesAlgo.encrypt(utf8ToBytes(text));
  
      return {
        ciphertext: bytesToHex(ciphertext),
        nonce: bytesToHex(nonce)
      };
    } catch (err) {
      console.log(err);
      console.log('[canvas] Encryption error; message failed to encrypt/decrypt');
      return null;
    }
  }

  const getDecryptedTextContent = ({ciphertext, nonce}: {ciphertext: string, nonce: string}) => {
    const privKey = getBurnerWallet();
    const recipientKey = otherPlayer?.key;

    if (!recipientKey) return;

    try {
      const sharedSecret = secp256k1.getSharedSecret(privKey.slice(2), recipientKey.slice(2));
  
      const aesKey = sha256(sharedSecret);
      const aesAlgo = gcm(aesKey, hexToBytes(nonce));
      const plaintext = aesAlgo.decrypt(hexToBytes(ciphertext));

      return bytesToUtf8(plaintext);
    } catch (err) {
      console.log(err);
      console.log('[canvas] Encryption error; message failed to encrypt/decrypt');
      return null;
    }
  }

  const sendMessage = useCallback(async () => {
    if (!app) return;
    if (newMessage.length === 0) {
      blurInput();
      return;
    }

    const name = getPlayerName();
    if (channel === CHANNELS.ALL) {
      try {
        setNewMessage("");
        blurInput();
  
        await app.actions.createMessage({
          content: newMessage,
          name,
          channel,
          nonce: "N/A",
          player: currentPlayer.player,
          color: currentPlayer.playerColor.color.toString(16),
        });
        sendAnalyticsEvent("sent-message", { matchEntity });
      } catch (err) {
        console.error(err);
      }
    } 
    
    if (channel === CHANNELS.PLAYER) {
      if (!otherPlayer) {
        return;
      }

      const encryptedText = getEncryptedTextContent({ text: newMessage });

      if (!encryptedText) {
        return;
      }

      try {
        setNewMessage("");
        blurInput();
  
        await app.actions.createMessage({
          content: encryptedText.ciphertext,
          nonce: encryptedText.nonce,
          name,
          channel,
          player: currentPlayer.player,
          color: currentPlayer.playerColor.color.toString(16),
        });
        sendAnalyticsEvent("sent-message", { matchEntity });
      } catch (err) {
        console.error(err);
      }
    }
  }, [
    Name,
    app,
    blurInput,
    currentPlayer.playerColor.color,
    externalWalletClient.address,
    matchEntity,
    newMessage,
    sendAnalyticsEvent,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement === inputRef.current) return;

      if (e.key === "Enter" && e.shiftKey) {
        if (!!otherPlayer) {
          setChannel(CHANNELS.PLAYER);
        } else {
          setChannel(CHANNELS.ALL);
        }

        focusInput();
        e.preventDefault();
      } else if (e.key === "Enter") {
        setChannel(CHANNELS.ALL);
        focusInput();
        e.preventDefault();
      } else if (e.key === "Escape") {
        blurInput();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [blurInput, focusInput, otherPlayer]);

  const availableChannels = [
    CHANNELS.ALL, 
    ...(otherPlayer ? [CHANNELS.PLAYER] : [])
  ];

  // Tailwind can't interpolate variables in class strings, so we need to switch the whole class string here for the pl-* values.
  const getInputClass = () => {
    if (channel === CHANNELS.ALL) {
      return `w-full outline-none px-2 pl-[46px] text-white py-1 bg-black/70 opacity-0 focus:opacity-100 border border-ss-stroke rounded`
    }

    if (channel === CHANNELS.PLAYER) {
      return `w-full outline-none px-2 pl-[74px] text-white py-1 bg-black/70 opacity-0 focus:opacity-100 border border-ss-stroke rounded`
    }

    return '';
  }

  return (
    <div
      style={{
        opacity: lastInteraction.plus({ seconds: secondsVisibleAfterInteraction }).diff(now).milliseconds > 0 ? 1 : 0,
      }}
      onMouseMove={() => {
        setLastInteraction(DateTime.now());
      }}
      className="absolute bottom-12 pb-[37px] left-0 h-[300px] w-[300px] rounded border border-ss-stroke bg-black/25 transition-all duration-300"
    >
      <ChannelTabs>
        {availableChannels.map((channelOption) => (
          <ClickWrapper>
            <ChannelTab
              key={channelOption}
              style={{ ...(channel === channelOption && { backgroundColor: '#4A76A8' }) }}
              onClick={() => setChannel(channel)}
            >
              {channelOption}
            </ChannelTab>
          </ClickWrapper>
        ))}
      </ChannelTabs>
      <div className="h-full w-full">
        <div className="w-full overflow-y-auto">
          <ul
            style={{
              overflowAnchor: "none",
            }}
            className="h-full w-full px-2 space-y-1 flex flex-col"
          >
            <div className="grow" />

            {(messages ?? []).map((message: Message) => {
              if (message.channel !== channel) return;

              let textContent;

              if (message.channel === CHANNELS.ALL) {
                textContent = message.content;
              }

              if (message.channel === CHANNELS.PLAYER) {
                const decryptedText = getDecryptedTextContent({ciphertext: message.content, nonce: message.nonce});

                textContent = decryptedText;
              }

              return (
                <li
                  style={{
                    textShadow: "0 0 2px black",
                    overflowWrap: "anywhere",
                  }}
                  key={message.id}
                  className="flex text-white items-baseline flex-wrap space-x-1 w-full"
                >
                  <span
                    style={{
                      color: message.color,
                    }}
                    className="font-bold"
                  >
                    {message.name}:
                  </span>
                  <span>{textContent}</span>
                </li>
              );
            })}
            <div ref={scrollIntoViewRef} />
          </ul>
        </div>

        <div className="h-2" />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          onKeyDown={(e) => {
            if (inputRef.current !== document.activeElement) return;
            if (e.key === "Escape") blurInput();

            setLastInteraction(DateTime.now());
          }}
          className="relative"
        >
          <div
            style={{
              display: inputFocused ? "block" : "none",
            }}
            className="absolute left-2 top-[5px] text-white"
          >
            [{channel}]
          </div>
          <input
            onFocus={() => {
              setLastInteraction(DateTime.now());
              setInputFocused(true);
            }}
            ref={inputRef}
            type="text"
            className={getInputClass()}
            value={newMessage}
            placeholder="Type a message"
            onChange={(e) => setNewMessage(e.target.value)}
            disabled={!app || app.status !== "connected"}
          />
          {inputFocused &&
            (app?.status === "connected" ? (
              <div className="absolute top-[9px] right-2 w-4 h-4 rounded-full bg-green-500" />
            ) : (
              <div className="absolute top-[9px] right-2 w-4 h-4 rounded-full animate-pulse bg-red-500" />
            ))}
        </form>
      </div>
    </div>
  );
}

const ChannelTabs = styled.div`
  display: flex;
  padding: 4px;
  background: rgba(0, 0, 0, 0.5); /* Semi-transparent background */
  border-radius: 4px 4px 0px 0px;
  gap: 4px;
  font-size: 12px;
`;

const ChannelTab = styled.button`
  padding: 6px 12px;
  cursor: pointer;
  color: white;
  border-radius: 4px;

  width: 100%;
`;

