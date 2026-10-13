/**
 * Emoji voor de kiezer in de teamchat, met Nederlandse zoekwoorden. Bewust een
 * handzame selectie (wat je op het werk gebruikt), geen volledige Unicode-lijst.
 */

/** De zes snelle reacties van Teams: duim, hart, lach, verbaasd, verdrietig, boos. */
export const QUICK_REACTIONS: { emoji: string; label: string }[] = [
  { emoji: '👍', label: 'Leuk' },
  { emoji: '❤️', label: 'Hart' },
  { emoji: '😆', label: 'Lach' },
  { emoji: '😮', label: 'Verbaasd' },
  { emoji: '😢', label: 'Verdrietig' },
  { emoji: '😠', label: 'Boos' },
];

export interface EmojiCategory {
  key: string;
  label: string;
  icon: string;
  items: { e: string; k: string }[];
}

const parse = (spec: string) => spec.trim().split('\n').map((line) => {
  const [e, ...k] = line.trim().split(' ');
  return { e, k: k.join(' ') };
}).filter((x) => x.e);

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    key: 'smileys', label: 'Smileys', icon: '😀', items: parse(`
😀 grijns lach blij
😃 lach blij vrolijk
😄 lach blij ogen
😁 grijns tanden
😆 lachen hard lol
😅 zweet opgelucht pfoe
🤣 rollen lachen lol
😂 tranen lachen lol
🙂 glimlach
🙃 ondersteboven ironisch
😉 knipoog
😊 blij bloos
😇 engel onschuldig
🥰 verliefd hartjes
😍 hartjesogen verliefd
🤩 sterren wow
😘 kus
😋 lekker smullen
😛 tong
😜 tong knipoog gek
🤪 gek
🤗 knuffel
🤭 oeps hand mond
🤫 stil sst
🤔 denken hmm
🤐 rits mond stil
🤨 wenkbrauw twijfel
😐 neutraal
😑 uitdrukkingloos
😶 sprakeloos
😏 grijns zelfvoldaan
😒 chagrijnig
🙄 ogen rollen
😬 grimas oeps
😌 opgelucht
😔 peinzend
😪 slaperig
😴 slapen moe
😷 mondkapje ziek
🤒 ziek koorts
🤯 ontploft hoofd
🥳 feest hoera
😎 cool zonnebril
🤓 nerd
🧐 monocle onderzoeken
😕 verward
😟 bezorgd
🙁 sip
😮 verbaasd oh
😲 geschokt
😳 bloos verlegen
🥺 smeken please
😢 huilen verdrietig traan
😭 hard huilen
😱 schreeuw bang
😩 moe zucht
🥱 gapen moe
😤 boos stoom
😠 boos
😡 woedend rood
🤬 vloeken
💀 dood lachen
💩 poep
🤡 clown
👻 spook
🤖 robot
`),
  },
  {
    key: 'people', label: 'Gebaren', icon: '👍', items: parse(`
👍 duim omhoog oke goed
👎 duim omlaag slecht
👌 oke perfect
✌️ vrede twee
🤞 duimen hopen
🤟 love you
🤘 rock
🤙 bel me
👈 links
👉 rechts
👆 boven
👇 onder
☝️ een vinger
✋ hand stop
👋 zwaaien hoi doei
👏 applaus klappen
🙌 hoera handen
🤲 handen
🤝 handdruk deal afspraak
🙏 dank alsjeblieft bidden
✍️ schrijven
💪 sterk spier
🧠 brein slim
👀 ogen kijken
🫡 saluut begrepen
🤷 schouders weet niet
🤦 facepalm
🙋 vinger opsteken ik
🙇 buigen sorry
🏃 rennen haast
🚶 lopen
💃 dansen
🕺 dansen
`),
  },
  {
    key: 'symbols', label: 'Symbolen', icon: '❤️', items: parse(`
❤️ hart liefde
🧡 oranje hart
💛 geel hart
💚 groen hart
💙 blauw hart
💜 paars hart
🖤 zwart hart
🤍 wit hart
💔 gebroken hart
💯 honderd perfect
✅ vinkje klaar gedaan
☑️ aangevinkt
✔️ vinkje
❌ kruis nee fout
❗ uitroepteken belangrijk
❓ vraag
⚠️ waarschuwing let op
🚫 verboden
⭐ ster
🌟 ster glans
✨ glitter nieuw
🔥 vuur heet
💥 boem
💡 idee lamp
🔔 bel melding
📌 punaise vastmaken
🎯 doel raak
🏆 beker winnen
🥇 goud eerste
🎉 feest hoera confetti
🎊 confetti
🎈 ballon
🎁 cadeau
🎂 taart verjaardag
🍾 champagne
➕ plus
➖ min
➡️ pijl rechts
⬅️ pijl links
🔁 herhalen
🆕 nieuw
🆗 oke
`),
  },
  {
    key: 'work', label: 'Werk', icon: '💼', items: parse(`
💼 werk koffer
📁 map
📂 map open
📄 document pagina
📝 notitie memo
📎 paperclip bijlage
✏️ potlood
🖊️ pen
📅 agenda datum
🗓️ kalender planning
⏰ wekker
⏳ zandloper wachten
🕒 klok tijd
📞 telefoon bellen
📱 mobiel
💻 laptop
🖥️ computer
⌨️ toetsenbord
🖨️ printer
📷 camera foto
🎥 video camera
🎬 film klap
🎤 microfoon
🎧 koptelefoon
📢 megafoon aankondiging
📊 grafiek staaf
📈 stijgend groei
📉 dalend
💰 geld zak
💶 euro geld
💳 pin kaart
🧾 bon factuur
🔑 sleutel
🔒 slot dicht
🔓 slot open
🛠️ gereedschap
🔧 moersleutel
⚙️ instellingen tandwiel
🧩 puzzel
🚀 raket lancering live
✈️ vliegtuig reis
🚗 auto
🚲 fiets
🏠 huis thuis
🏢 kantoor
📦 pakket doos
✉️ envelop mail
📧 email
`),
  },
  {
    key: 'food', label: 'Eten', icon: '☕', items: parse(`
☕ koffie
🍵 thee
🍺 bier
🍻 proost bier
🍷 wijn
🥂 proosten
🍕 pizza
🍔 burger
🍟 friet patat
🥪 broodje lunch
🥗 salade
🍝 pasta
🍣 sushi
🍰 taart gebak
🍩 donut
🍪 koekje
🍫 chocola
🍎 appel
🍌 banaan
🍓 aardbei
🥑 avocado
🥐 croissant
`),
  },
  {
    key: 'nature', label: 'Natuur', icon: '🌤️', items: parse(`
☀️ zon zonnig
🌤️ zon wolk
⛅ bewolkt
🌧️ regen
⛈️ onweer
❄️ sneeuw koud
🌈 regenboog
🌙 maan nacht
🌍 wereld aarde
🌱 groei plant
🌳 boom
🌸 bloem bloesem
🌻 zonnebloem
🍀 klaver geluk
🐶 hond
🐱 kat
🦄 eenhoorn
🐝 bij
🦋 vlinder
🐢 schildpad langzaam
🐌 slak traag
`),
  },
];

const RECENT_KEY = 'resofly.chat.emojiRecent';

export function recentEmoji(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 16) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    const next = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 16);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* privé-venster */ }
}

export function searchEmoji(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: string[] = [];
  for (const cat of EMOJI_CATEGORIES) {
    for (const item of cat.items) {
      if (item.k.split(' ').some((word) => word.startsWith(q)) || item.k.includes(q)) out.push(item.e);
    }
  }
  return [...new Set(out)].slice(0, 64);
}
