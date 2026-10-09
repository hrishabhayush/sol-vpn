use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // ponytail: fixed 16 slots x 16 nodes. The whole encrypted state is rewritten by every
    // callback and must fit one 1232-byte Solana tx; more slots need sharding or multi-tx callbacks.
    pub const SLOTS: usize = 16;
    pub const NODES: usize = 16;

    #[derive(Copy, Clone)]
    pub struct Slot {
        balance: u32, // minutes
        secret: u64,  // 0 = unclaimed
        counter: u32, // last redeemed voucher counter
        escrow: u16,  // minutes reserved for `node`, 0 = no open session
        node: u8,
    }

    type Slots = Pack<[Slot; SLOTS]>;
    type Earnings = Pack<[u32; NODES]>; // cumulative minutes per node, never reset

    pub struct DepositIn {
        slot: u8,
        secret: u64,
    }

    pub struct ReserveIn {
        slot: u8,
        secret: u64,
        minutes: u32,
    }

    pub struct Voucher {
        slot: u8,
        secret: u64,
        total_minutes: u32,
        counter: u32,
        node_id: u8,
    }

    #[instruction]
    pub fn init_ledger() -> (Enc<Mxe, Slots>, Enc<Mxe, Earnings>) {
        let empty = Slot { balance: 0, secret: 0, counter: 0, escrow: 0, node: 0 };
        (
            Mxe::get().from_arcis(Pack::new([empty; SLOTS])),
            Mxe::get().from_arcis(Pack::new([0u32; NODES])),
        )
    }

    /// Credits `minutes` to the slot if it is unclaimed (claims it) or the secret matches.
    /// Reveals only ok; on !ok the program refunds the deposit.
    #[instruction]
    pub fn deposit(
        input: Enc<Shared, DepositIn>,
        minutes: u32,
        state: Enc<Mxe, Slots>,
    ) -> (Enc<Mxe, Slots>, bool) {
        let d = input.to_arcis();
        let mut s = state.to_arcis().unpack();
        let mut ok = false;
        for i in 0..SLOTS {
            let hit = d.slot == i as u8
                && d.secret != 0
                && (s[i].secret == d.secret || s[i].secret == 0);
            if hit {
                s[i].secret = d.secret;
                s[i].balance += minutes;
            }
            ok = ok || hit;
        }
        (state.owner.from_arcis(Pack::new(s)), ok.reveal())
    }

    /// Moves `minutes` from the slot balance into escrow for `node_id`. Reveals (ok, minutes).
    #[instruction]
    pub fn reserve(
        input: Enc<Shared, ReserveIn>,
        node_id: u8,
        state: Enc<Mxe, Slots>,
    ) -> (Enc<Mxe, Slots>, bool, u32) {
        let r = input.to_arcis();
        let mut s = state.to_arcis().unpack();
        let mut ok = false;
        for i in 0..SLOTS {
            let hit = r.slot == i as u8
                && r.secret != 0
                && s[i].secret == r.secret
                && s[i].escrow == 0
                && r.minutes > 0
                && r.minutes <= 65535
                && s[i].balance >= r.minutes;
            if hit {
                s[i].balance -= r.minutes;
                s[i].escrow = r.minutes as u16;
                s[i].node = node_id;
            }
            ok = ok || hit;
        }
        let minutes = if ok { r.minutes } else { 0 };
        (state.owner.from_arcis(Pack::new(s)), ok.reveal(), minutes.reveal())
    }

    /// Node-submitted. Charges min(total_minutes, escrow) to node_id, refunds the rest.
    /// Rejects (ok=false, no state change) unless counter > stored counter.
    #[instruction]
    pub fn redeem(
        input: Enc<Shared, Voucher>,
        node_id: u8,
        state: Enc<Mxe, Slots>,
        earnings: Enc<Mxe, Earnings>,
    ) -> (Enc<Mxe, Slots>, Enc<Mxe, Earnings>, bool) {
        let v = input.to_arcis();
        let mut s = state.to_arcis().unpack();
        let mut e = earnings.to_arcis().unpack();
        let mut ok = false;
        let mut charge: u32 = 0;
        for i in 0..SLOTS {
            let hit = v.slot == i as u8
                && v.secret != 0
                && s[i].secret == v.secret
                && v.node_id == node_id
                && s[i].node == node_id
                && s[i].escrow > 0
                && v.counter > s[i].counter;
            if hit {
                let held = s[i].escrow as u32;
                let c = v.total_minutes.min(held);
                s[i].balance += held - c;
                s[i].escrow = 0;
                s[i].counter = v.counter;
                charge = c;
            }
            ok = ok || hit;
        }
        for n in 0..NODES {
            if n as u8 == node_id {
                e[n] += charge;
            }
        }
        (
            state.owner.from_arcis(Pack::new(s)),
            earnings.owner.from_arcis(Pack::new(e)),
            ok.reveal(),
        )
    }

    /// Reveals cumulative per-node earnings (minutes). The program pays out the delta.
    #[instruction]
    pub fn settle(earnings: Enc<Mxe, Earnings>) -> [u32; NODES] {
        earnings.to_arcis().unpack().reveal()
    }
}
