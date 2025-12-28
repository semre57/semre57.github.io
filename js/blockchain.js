/**
 * SimpleBlockchain (SENG Project)
 * --------------------------------
 * Amaç: "Blockchain mantığını" (hash ile birbirine bağlı bloklar) basit ve anlaşılır biçimde göstermek.
 * - Proof of Work / mining yok
 * - Tek hash standardı: SHA-256
 * - Bloklar previousHash ile birbirine bağlanır
 * - Sunum kolaylığı için ayrıca nextHash pointer'ı tutulur (hash hesabına dahil DEĞİL)
 *
 * Not: Bu proje demo/akademik amaçlıdır. Gerçek seçim için uygun değildir.
 */

(function () {
  "use strict";

  // ---------- Yardımcılar ----------
  function nowISO() {
    return new Date().toISOString();
  }

  // JSON'u deterministik hale getir (hash için aynı input -> aynı output)
  function canonicalStringify(value) {
    if (value === null || value === undefined) return "null";

    const t = typeof value;
    if (t === "number" || t === "boolean") return String(value);
    if (t === "string") return JSON.stringify(value);

    if (Array.isArray(value)) {
      return "[" + value.map(canonicalStringify).join(",") + "]";
    }

    // object
    const keys = Object.keys(value).sort();
    const props = keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k]));
    return "{" + props.join(",") + "}";
  }

  async function sha256Hex(input) {
    const enc = new TextEncoder();
    const data = enc.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function voterCommitment(voterId) {
    // Sunum için basit: voterId'nin SHA-256'sı.
    // (Ürünleştirme aşamasında HMAC / salt / backend'e taşınabilir.)
    return await sha256Hex(String(voterId));
  }

  // ---------- Block ----------
  class Block {
    constructor({ index, timestamp, data, previousHash }) {
      this.index = index;
      this.timestamp = timestamp;
      this.data = data; // { voterHash, candidateId, ... }
      this.previousHash = previousHash;
      this.hash = ""; // hesaplanacak
      this.nextHash = null; // pointer (hash'e dahil değil)
    }

    async calculateHash() {
      const payload =
        String(this.index) +
        "|" +
        this.timestamp +
        "|" +
        canonicalStringify(this.data) +
        "|" +
        this.previousHash;

      return await sha256Hex(payload);
    }
  }

  // ---------- Blockchain ----------
  class SimpleBlockchain {
    constructor({ storageKey = "voteChainV1", genesisMessage = "Genesis Block" } = {}) {
      this.storageKey = storageKey;
      this.genesisMessage = genesisMessage;
      this.chain = [];
      this._loadOrInit();
    }

    getChain() {
      // dışarıya kopya verelim (UI yanlışlıkla değiştirmesin)
      return JSON.parse(JSON.stringify(this.chain));
    }

    getHeadHash() {
      if (this.chain.length === 0) return null;
      return this.chain[this.chain.length - 1].hash;
    }

    _loadOrInit() {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        // ilk kurulum: genesis oluştur
        this.chain = [];
        // genesis async hash hesaplayacağı için sync init sonrası tamamlarız:
        // (constructor içinde await kullanamayız)
        this._initGenesis();
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          this.chain = [];
          this._initGenesis();
          return;
        }
        this.chain = parsed;
      } catch (e) {
        // bozuk veri varsa sıfırdan başla
        this.chain = [];
        this._initGenesis();
      }
    }

    async _initGenesis() {
      const genesis = new Block({
        index: 0,
        timestamp: nowISO(),
        data: { message: this.genesisMessage },
        previousHash: "0"
      });
      genesis.hash = await genesis.calculateHash();
      genesis.nextHash = null;

      this.chain = [genesis];
      this._save();
    }

    _save() {
      localStorage.setItem(this.storageKey, JSON.stringify(this.chain));
    }

    async addVote({ voterId, candidateId, extra = {} }) {
      // Zincir hazır değilse (genesis async), bekle
      if (this.chain.length === 0) {
        await this._initGenesis();
      }

      // Önce zincirin mevcut hali geçerli mi?
      const verification = await this.verify();
      if (!verification.ok) {
        throw new Error("Chain verification failed: " + verification.reason);
      }

      const voterHash = await voterCommitment(voterId);

      // double-vote kontrolü (demo seviyesinde)
      const already = this.chain.some((b) => b && b.data && b.data.voterHash === voterHash);
      if (already) {
        throw new Error("This user has already submitted a vote.");
      }

      const previousBlock = this.chain[this.chain.length - 1];

      // TxID: Bu oy işleminin kimliği (işlem zincire yazıldıktan sonra doğrulanabilir)
      const timestamp = nowISO();
      const txId = await sha256Hex(
        "TX|" + timestamp + "|" + voterHash + "|" + candidateId + "|" + previousBlock.hash
      );

      const newBlock = new Block({
        index: this.chain.length,
        timestamp,
        data: {
          voterHash,
          candidateId,
          txId,
          ...extra
        },
        previousHash: previousBlock.hash
      });

      newBlock.hash = await newBlock.calculateHash();

      // çift yön pointer (sunum kolaylığı)
      previousBlock.nextHash = newBlock.hash;

      this.chain.push(newBlock);
      this._save();

      // UI'da "blockchain yazma" hissi için minik gecikme
      await new Promise((r) => setTimeout(r, 300));
      return { txId, blockHash: newBlock.hash, index: newBlock.index };
    }

    
async inspectHash(hash) {
  // Belirli bir hash'in zincirdeki yerini ve komşu uyumlarını kontrol eder.
  if (!hash || typeof hash !== "string") {
    return { found: false, reason: "Invalid hash input." };
  }

  // Zincir hazır değilse (genesis async), bekle
  if (this.chain.length === 0) {
    await this._initGenesis();
  }

  const idx = this.chain.findIndex((b) => b && b.hash === hash.trim());
  if (idx === -1) {
    return { found: false, reason: "Hash not found in the blockchain" };
  }

  const block = this.chain[idx];

  // Hash'in kendisi doğru mu? (içerikten tekrar hesapla)
  const calc = await (new Block({
    index: block.index,
    timestamp: block.timestamp,
    data: block.data,
    previousHash: block.previousHash
  })).calculateHash();

  const selfOk = (calc === block.hash);

  // Önceki bağlantı doğru mu?
  const prevOk = idx === 0
    ? null // Genesis bloğunun önceki bloğu yok
    : (block.previousHash === this.chain[idx - 1].hash);

  // Sonraki bağlantı doğru mu? (pointer tutarlılığı)
  const nextOk = idx === this.chain.length - 1
    ? null // Head bloğun sonraki bloğu yok
    : (block.nextHash === this.chain[idx + 1].hash);

  return {
    found: true,
    index: idx,
    // Terimler:
    // - chainLength: zincirde toplam blok sayısı (genesis dahil)
    // - chainHeight: zincirin "yüksekliği" (son bloğun index'i)
    // - blockHeight: bu bloğun yüksekliği (block.index)
    chainLength: this.chain.length,
    chainHeight: Math.max(0, this.chain.length - 1),
    blockHeight: block.index,
    headHash: this.getHeadHash(),
    checks: { selfOk, prevOk, nextOk },
    block: JSON.parse(JSON.stringify(block))
  };
}

async verify() {
      // genesis yoksa otomatik düzelt
      if (this.chain.length === 0) {
        await this._initGenesis();
        return { ok: true, height: 1, headHash: this.getHeadHash() };
      }

      // Genesis kontrol
      const g = this.chain[0];
      if (!g || g.index !== 0 || g.previousHash !== "0") {
        return { ok: false, reason: "Genesis block is invalid." };
      }
      // genesis hash doğru mu?
      const gCalc = await (new Block({
        index: g.index,
        timestamp: g.timestamp,
        data: g.data,
        previousHash: g.previousHash
      })).calculateHash();

      if (g.hash !== gCalc) {
        return { ok: false, reason: "Genesis hash mismatch." };
      }

      // Zincir kontrol
      for (let i = 1; i < this.chain.length; i++) {
        const prev = this.chain[i - 1];
        const cur = this.chain[i];

        if (cur.index !== i) {
          return { ok: false, reason: "Index error (block " + i + ")." };
        }

        if (cur.previousHash !== prev.hash) {
          return { ok: false, reason: "previousHash mismatch (block " + i + ")." };
        }

        // prev.nextHash pointer kontrol (hash'e dahil değil, ama tutarlı olmalı)
        if (prev.nextHash !== cur.hash) {
          return { ok: false, reason: "nextHash pointer mismatch (block " + (i - 1) + ")." };
        }

        const curCalc = await (new Block({
          index: cur.index,
          timestamp: cur.timestamp,
          data: cur.data,
          previousHash: cur.previousHash
        })).calculateHash();

        if (cur.hash !== curCalc) {
          return { ok: false, reason: "Hash mismatch (block " + i + ")." };
        }
      }

      return { ok: true, height: this.chain.length, headHash: this.getHeadHash() };
    }

    // =========================
    // Export / Import (Denetim & Taşınabilirlik)
    // =========================

    exportSnapshot() {
      // Denetim amaçlı zincir çıktısı. (Son kullanıcı özelliği değil.)
      return {
        schema: "SENG_CHAIN_V1",
        exportedAt: nowISO(),
        storageKey: this.storageKey,
        chain: this.getChain()
      };
    }

    async _verifyChainData(chainData) {
      if (!Array.isArray(chainData) || chainData.length === 0) {
        return { ok: false, reason: "Chain data is empty or invalid." };
      }

      // Genesis kontrol
      const g = chainData[0];
      if (!g || g.index !== 0 || g.previousHash !== "0") {
        return { ok: false, reason: "Genesis block is invalid." };
      }

      const gCalc = await (new Block({
        index: g.index,
        timestamp: g.timestamp,
        data: g.data,
        previousHash: g.previousHash
      })).calculateHash();

      if (g.hash !== gCalc) {
        return { ok: false, reason: "Genesis hash mismatch." };
      }

      for (let i = 1; i < chainData.length; i++) {
        const prev = chainData[i - 1];
        const cur = chainData[i];

        if (!cur || cur.index !== i) {
          return { ok: false, reason: "Index hatası (block " + i + ")." };
        }

        if (cur.previousHash !== prev.hash) {
          return { ok: false, reason: "previousHash mismatch (block " + i + ")." };
        }

        // nextHash pointer kontrolü (hash'e dahil değil, ama tutarlı olmalı)
        if (prev.nextHash !== cur.hash) {
          return { ok: false, reason: "nextHash pointer mismatch (block " + (i - 1) + ")." };
        }

        const curCalc = await (new Block({
          index: cur.index,
          timestamp: cur.timestamp,
          data: cur.data,
          previousHash: cur.previousHash
        })).calculateHash();

        if (cur.hash !== curCalc) {
          return { ok: false, reason: "Hash mismatch (block " + i + ")." };
        }
      }

      return { ok: true, height: chainData.length, headHash: chainData[chainData.length - 1].hash };
    }

    async importSnapshot(snapshotOrChain) {
      // snapshotOrChain: exportSnapshot() çıktısı veya direkt chain array.
      const chainData = Array.isArray(snapshotOrChain)
        ? snapshotOrChain
        : (snapshotOrChain && Array.isArray(snapshotOrChain.chain) ? snapshotOrChain.chain : null);

      if (!chainData) {
        return { ok: false, reason: "Failed to read import data. 'chain' not found in JSON." };
      }

      const v = await this._verifyChainData(chainData);
      if (!v.ok) return v;

      // Import başarılı -> zinciri değiştir ve kaydet
      this.chain = chainData;
      this._save();
      return { ok: true, height: this.chain.length, headHash: this.getHeadHash() };
    }
  }

  // Global'e çıkar (HTML doğrudan kullanabilsin)
  window.SimpleBlockchain = SimpleBlockchain;
})();