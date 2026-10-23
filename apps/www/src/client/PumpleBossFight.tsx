import { useEffect, useRef, useState } from 'react'

type Mob = { id: number; x: number; y: number; hp: number }
type Shot = { id: number; x: number; y: number; vx: number; vy: number; bomb?: boolean }
type Game = {
    player: number
    hp: number
    bossHp: number
    mobs: Mob[]
    enemyShots: Shot[]
    arrows: Shot[]
    bombs: number
    kills: number
    waves: number
    nextId: number
    lastSpawn: number
    lastAttack: number
    phase: 'fight' | 'victory' | 'defeat'
}
const freshGame = (): Game => ({
    player: (typeof window !== 'undefined' ? window.innerWidth : 1024) / 2, hp: 100, bossHp: 100,
    mobs: [], enemyShots: [], arrows: [], bombs: 0, kills: 0,
    waves: 1, nextId: 1, lastSpawn: 0, lastAttack: 0, phase: 'fight',
})

const css = `
.rf-boss{position:fixed;inset:0;z-index:100010;overflow:hidden;background:radial-gradient(ellipse at 50% 34%,#542619 0%,#26121a 43%,#090810 100%);color:#fff0d5;font-family:system-ui,sans-serif;cursor:crosshair;user-select:none}
.rf-boss:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,#08060a66,transparent 35%,#05050988);z-index:0}
.rf-boss:after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.22;background-image:radial-gradient(#ffb35b 1px,transparent 1px);background-size:37px 37px;mask-image:linear-gradient(transparent,#000 30%,#000)}
.rf-boss *{box-sizing:border-box}
.rf-boss-hud{position:absolute;z-index:8;top:18px;left:50%;transform:translateX(-50%);width:min(900px,82%);display:grid;grid-template-columns:1.2fr 1fr;gap:22px;padding:16px 20px;border:1px solid #e9843c88;border-radius:15px;background:linear-gradient(135deg,#160d12eF,#2a1117eF);box-shadow:0 10px 45px #0009,inset 0 1px #ffd2a322;backdrop-filter:blur(8px)}
.rf-boss-label{font-weight:950;letter-spacing:2px;font-size:11px;text-transform:uppercase;margin-bottom:8px;color:#ffddb2}
.rf-boss-track{height:17px;border:1px solid #ffd9aa88;background:#100a10;border-radius:5px;overflow:hidden;box-shadow:inset 0 2px 5px #000a}
.rf-boss-fill{height:100%;background:linear-gradient(90deg,#a82420,#ff6036,#ffb05b);box-shadow:0 0 15px #ff552a99;transition:width .12s}
.rf-boss-player .rf-boss-fill{background:linear-gradient(90deg,#138a65,#49e7a0);box-shadow:0 0 14px #3df0a088}
.rf-boss-monster{position:absolute;z-index:4;top:16%;left:50%;width:min(43vw,390px);height:min(43vw,390px);min-width:230px;min-height:230px;transform:translateX(-50%);display:grid;place-items:center;filter:drop-shadow(0 0 18px #ff5b24aa);animation:rf-boss-hover 3s ease-in-out infinite}
.rf-boss-monster:before{content:"";position:absolute;width:90%;height:35%;bottom:0;border-radius:50%;background:#ff5a1726;filter:blur(25px)}
.rf-boss-monster img{position:relative;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;filter:drop-shadow(0 12px 0 #150a10) drop-shadow(0 0 16px #ff6b35aa)}
.rf-boss-minion{position:absolute;z-index:4;transform:translate(-50%,-50%);width:clamp(44px,7vw,78px);height:clamp(44px,7vw,78px);filter:drop-shadow(0 0 10px #ff4b2588);pointer-events:none}
.rf-boss-minion img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.rf-boss-shot{position:absolute;z-index:5;transform:translate(-50%,-50%);font-size:25px;pointer-events:none;filter:drop-shadow(0 0 9px #ff712f);animation:rf-shot-glow .5s ease-in-out infinite alternate}
.rf-boss-player-char{position:absolute;z-index:5;bottom:7%;font-size:42px;transform:translateX(-50%);width:64px;height:64px;display:grid;place-items:center;border-radius:50%;background:radial-gradient(circle,#77eaff35,transparent 70%);filter:drop-shadow(0 0 10px #7ad9ff);pointer-events:none}
.rf-boss-hint{position:absolute;z-index:8;bottom:14px;left:50%;transform:translateX(-50%);width:max-content;max-width:88%;text-align:center;font-size:11px;font-weight:850;letter-spacing:1px;color:#ffe3c1;padding:12px 18px;border:1px solid #b9684777;border-radius:9px;background:#100b13dc;box-shadow:0 4px 25px #0008}
.rf-boss-vines{position:absolute;z-index:6;inset:0;pointer-events:none;overflow:hidden;opacity:1}
.rf-boss-vines svg{position:absolute;inset:-2%;width:104%;height:104%;overflow:visible}
.rf-boss-vines .vine-main{fill:none;stroke:#172f1b;stroke-width:25;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 5px #050807)}
.rf-boss-vines .vine-edge{fill:none;stroke:#426a2d;stroke-width:12;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:25 8;animation:rf-vine-crawl 7s linear infinite}
.rf-boss-vines .vine-glow{fill:none;stroke:#df722a;stroke-width:3;stroke-linecap:round;stroke-dasharray:3 28;animation:rf-vine-crawl 4s linear infinite}
.rf-boss-vines .thorn{fill:#72913b;stroke:#18291a;stroke-width:3}
.rf-boss-vines .root{fill:none;stroke:#253d20;stroke-width:39;stroke-linecap:round;opacity:.92}
.rf-boss-vines-retreat{animation:rf-vine-retreat 2.8s ease-in forwards}
.rf-boss-end{position:absolute;z-index:10;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;background:linear-gradient(180deg,#08090bea,#130d0bea);padding:24px}
.rf-boss-panel{max-width:560px;width:100%;padding:clamp(26px,5vw,44px);border:2px solid #9b542d;border-radius:4px;background:#171310;box-shadow:8px 8px 0 #050505, inset 0 0 0 4px #171310, inset 0 0 0 5px #443023;color:#eee2ce}
.rf-boss-title{font-family:Impact,'Arial Narrow',system-ui,sans-serif;font-size:clamp(34px,6.5vw,60px);font-weight:900;line-height:1.05;letter-spacing:1px;text-transform:uppercase;color:#f0a04d;text-shadow:3px 3px 0 #522719;margin:0 0 20px}
.rf-boss-button{margin:10px 6px 0;border:2px solid #c47b43;border-radius:3px;padding:12px 20px;background:#30251b;color:#ffe5c3;font-family:inherit;font-size:13px;font-weight:800;letter-spacing:1px;text-transform:uppercase;cursor:pointer;box-shadow:0 3px 0 #090807;transition:background .12s,transform .12s}
.rf-boss-button:hover{background:#513522;transform:translateY(-2px)}
@keyframes rf-boss-hover{0%,100%{translate:0 0}50%{translate:0 -8px}}
@keyframes rf-shot-glow{from{scale:.9}to{scale:1.12}}
@keyframes rf-vine-crawl{to{stroke-dashoffset:-132}}
@keyframes rf-vine-retreat{to{transform:scale(1.4);opacity:0}}
@media(max-width:600px){.rf-boss-hud{top:10px;width:86%;padding:12px;gap:12px}.rf-boss-label{font-size:9px;letter-spacing:1px}.rf-boss-track{height:13px}.rf-boss-monster{top:23%;width:65vw;height:65vw;min-width:0;min-height:0}.rf-boss-hint{font-size:9px;letter-spacing:.3px;padding:10px;bottom:8px}}
@media(prefers-reduced-motion:reduce){.rf-boss-monster,.rf-boss-shot,.rf-boss-vines .vine-edge,.rf-boss-vines .vine-glow{animation:none}}
`

export function PumpleBossFight() {
    const [active, setActive] = useState(false)
    const [view, setView] = useState<Game>(freshGame)
    const game = useRef<Game>(freshGame())
    const mouse = useRef({ x: typeof window !== 'undefined' ? window.innerWidth / 2 : 512, y: typeof window !== 'undefined' ? window.innerHeight * .78 : 600 })
    const aim = useRef({ x: typeof window !== 'undefined' ? window.innerWidth / 2 : 512, y: typeof window !== 'undefined' ? window.innerHeight * .3 : 200 })
    const started = useRef(false)

    useEffect(() => {
        const start = () => {
            if (started.current) return
            started.current = true
            game.current = freshGame()
            mouse.current = { x: innerWidth / 2, y: innerHeight * .78 }
            setView({ ...game.current })
            setActive(true)
        }
        window.addEventListener('rf-pumple-boss', start)
        return () => window.removeEventListener('rf-pumple-boss', start)
    }, [])

    useEffect(() => {
        if (!active) return
        const g = game.current
        let last = performance.now()
        let frame = 0
        let endTimer = 0

        const tick = () => {
            const now = performance.now()
            const dt = Math.min(.05, (now - last) / 1000)
            last = now
            if (g.phase === 'fight') {
                g.player = Math.max(28, Math.min(innerWidth - 28, mouse.current.x))
                const difficulty = 1 + (g.waves - 1) * .18

                if (now - g.lastSpawn > Math.max(900, 3000 / difficulty) && g.mobs.length < 5 + g.waves) {
                    g.lastSpawn = now
                    g.mobs.push({ id: g.nextId++, x: Math.random() * (innerWidth - 80) + 40, y: innerHeight * (.35 + Math.random() * .28), hp: 2 })
                }
                if (now - g.lastAttack > Math.max(450, 1400 / difficulty)) {
                    g.lastAttack = now
                    const sx = innerWidth / 2, sy = innerHeight * .29
                    const dx = g.player - sx, dy = innerHeight * .78 - sy
                    const d = Math.hypot(dx, dy) || 1
                    g.enemyShots.push({ id: g.nextId++, x: sx, y: sy, vx: dx / d * 280 * difficulty, vy: dy / d * 280 * difficulty })
                    if (g.waves >= 2) {
                        g.enemyShots.push({ id: g.nextId++, x: sx, y: sy, vx: -dx / d * 240 * difficulty, vy: 270 * difficulty })
                    }
                }

                for (const m of g.mobs) {
                    const dx = g.player - m.x, dy = innerHeight * .78 - m.y, d = Math.hypot(dx, dy) || 1
                    m.x += dx / d * 75 * difficulty * dt
                    m.y += dy / d * 75 * difficulty * dt
                    if (d < 35) { g.hp -= 18 * dt; m.hp = 0 }
                }

                for (const s of g.enemyShots) { s.x += s.vx * dt; s.y += s.vy * dt }
                g.enemyShots = g.enemyShots.filter(s => {
                    if (Math.hypot(s.x - g.player, s.y - innerHeight * .78) < 32) { g.hp -= 12; return false }
                    return s.x > -50 && s.x < innerWidth + 50 && s.y < innerHeight + 50
                })

                for (const s of g.arrows) {
                    s.x += s.vx * dt; s.y += s.vy * dt
                    if (s.bomb) {
                        let detonated = false
                        for (const m of g.mobs) {
                            if (m.hp > 0 && Math.hypot(s.x - m.x, s.y - m.y) < 65) {
                                m.hp = 0
                                detonated = true
                            }
                        }
                        if (Math.hypot(s.x - innerWidth / 2, s.y - innerHeight * .29) < 115) {
                            g.bossHp -= 14
                            detonated = true
                        }
                        if (detonated) s.x = -999
                    } else {
                        let hit = false
                        for (const m of g.mobs) {
                            if (m.hp > 0 && Math.hypot(s.x - m.x, s.y - m.y) < 28) {
                                m.hp = 0
                                hit = true
                                break
                            }
                        }
                        if (!hit && Math.hypot(s.x - innerWidth / 2, s.y - innerHeight * .29) < 90) {
                            g.bossHp -= 2
                            hit = true
                        }
                        if (hit) s.x = -999
                    }
                }
                g.arrows = g.arrows.filter(s => s.x > -100 && s.x < innerWidth + 100 && s.y > -100 && s.y < innerHeight + 100)
                // Count defeated minions before removing them; some kills drop bombs.
                const dead = g.mobs.filter(m => m.hp <= 0)
                if (dead.length) {
                    g.kills += dead.length
                    for (let i = 0; i < dead.length; i++) {
                        if (Math.random() < .38) g.bombs++
                    }
                }
                g.mobs = g.mobs.filter(m => m.hp > 0)

                if (g.bossHp <= 0) g.phase = 'victory'
                else if (g.hp <= 0) g.phase = 'defeat'
                if (g.kills >= g.waves * 5) g.waves = Math.min(8, Math.floor(g.kills / 5) + 1)
            }
            setView({ ...g, mobs: [...g.mobs], enemyShots: [...g.enemyShots], arrows: [...g.arrows] })
            if (g.phase !== 'fight') {
                window.clearInterval(frame)
                endTimer = window.setTimeout(() => {
                    if (g.phase === 'defeat') window.location.reload()
                }, 6500)
            }
        }
        frame = window.setInterval(tick, 50) as unknown as number
        return () => { window.clearInterval(frame); window.clearTimeout(endTimer) }
    }, [active])

    const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
        mouse.current = { x: e.clientX, y: e.clientY }
        aim.current = { x: e.clientX, y: e.clientY }
    }
    const fire = (e: React.MouseEvent<HTMLDivElement>) => {
        if (view.phase !== 'fight') return
        const g = game.current
        const sx = g.player, sy = innerHeight * .78
        const dx = e.clientX - sx, dy = e.clientY - sy, d = Math.hypot(dx, dy) || 1
        g.arrows.push({ id: g.nextId++, x: sx, y: sy, vx: dx / d * 620, vy: dy / d * 620 })
    }
    const bomb = () => {
        const g = game.current
        if (!active || g.phase !== 'fight' || g.bombs <= 0) return
        g.bombs--
        const sx = g.player, sy = innerHeight * .78
        const dx = aim.current.x - sx, dy = aim.current.y - sy, d = Math.hypot(dx, dy) || 1
        g.arrows.push({ id: g.nextId++, x: sx, y: sy, vx: dx / d * 350, vy: dy / d * 350, bomb: true })
        setView({ ...g, arrows: [...g.arrows] })
    }
    useEffect(() => {
        if (!active) return
        const key = (e: KeyboardEvent) => { if (e.code === 'Space') { e.preventDefault(); bomb() } }
        window.addEventListener('keydown', key)
        return () => window.removeEventListener('keydown', key)
    }, [active])

    if (!active) return null
    const ended = view.phase !== 'fight'
    return <div className="rf-boss" onMouseMove={onMove} onClick={fire} onContextMenu={e => e.preventDefault()}>
        <style>{css}</style>
        <div className="rf-boss-hud">
            <div style={{ flex: 1 }}><div className="rf-boss-label">YOUR HEALTH {Math.max(0, Math.ceil(view.hp))}/100</div><div className="rf-boss-track rf-boss-player"><div className="rf-boss-fill" style={{ width: `${Math.max(0, view.hp)}%` }} /></div></div>
            <div style={{ flex: 1 }}><div className="rf-boss-label">PUMPLE {Math.max(0, Math.ceil(view.bossHp))}%</div><div className="rf-boss-track"><div className="rf-boss-fill" style={{ width: `${Math.max(0, view.bossHp)}%` }} /></div></div>
        </div>
        <div className="rf-boss-monster">
            <img src={new URL('./pumple-frames/frame-04.png', import.meta.url).href} alt="Pumple, the pumpkin king" draggable={false} />
        </div>
        {view.mobs.map(m => <div key={m.id} className="rf-boss-minion" style={{ left: m.x, top: m.y }}>
            <img src={new URL('./Pumple_monster_walk.gif', import.meta.url).href} alt="" draggable={false} />
        </div>)}
        {view.enemyShots.map(s => <div key={s.id} className="rf-boss-shot" style={{ left: s.x, top: s.y }}>🔥</div>)}
        {view.arrows.map(s => <div key={s.id} className="rf-boss-shot" style={{ left: s.x, top: s.y }}>{s.bomb ? '💣' : '➶'}</div>)}
        <div className="rf-boss-player-char" style={{ left: view.player }}>🛡️</div>
        <div className="rf-boss-hint">MOVE YOUR MOUSE TO DODGE · CLICK TO SHOOT ARROWS · SPACE: PUMPKIN BOMB ({view.bombs}) · WAVE {view.waves}</div>
        <div className={`rf-boss-vines ${view.phase === 'victory' ? 'rf-boss-vines-retreat' : ''}`}>
            <svg viewBox="0 0 1200 800" preserveAspectRatio="none" aria-hidden="true">
                <path className="root" d="M-30 30 Q70 90 45 190 T120 340 T65 520 T150 830 M1230 20 Q1110 95 1155 210 T1080 370 T1160 560 T1050 830 M-20 790 Q100 700 210 780 T390 760 M1220 790 Q1100 700 990 780 T810 760"/>
                <path className="vine-main" d="M-30 30 Q70 90 45 190 T120 340 T65 520 T150 830 M1230 20 Q1110 95 1155 210 T1080 370 T1160 560 T1050 830 M-20 790 Q100 700 210 780 T390 760 M1220 790 Q1100 700 990 780 T810 760 M-20 300 Q100 250 160 330 T250 390 M1220 450 Q1100 390 1050 460 T960 510"/>
                <path className="vine-edge" d="M-30 30 Q70 90 45 190 T120 340 T65 520 T150 830 M1230 20 Q1110 95 1155 210 T1080 370 T1160 560 T1050 830 M-20 790 Q100 700 210 780 T390 760 M1220 790 Q1100 700 990 780 T810 760 M-20 300 Q100 250 160 330 T250 390 M1220 450 Q1100 390 1050 460 T960 510"/>
                <path className="vine-glow" d="M-30 30 Q70 90 45 190 T120 340 T65 520 T150 830 M1230 20 Q1110 95 1155 210 T1080 370 T1160 560 T1050 830 M-20 790 Q100 700 210 780 T390 760 M1220 790 Q1100 700 990 780 T810 760"/>
                <g className="thorn">
                    <path d="M54 180 l-35 -18 27 43z M94 305 l-36 -8 30 31z M81 500 l-33 -18 23 39z M1140 200 l34 -24 -24 48z M1100 360 l37 -12 -29 36z M1134 545 l36 -19 -23 43z M190 760 l-5 -40 27 31z M1010 760 l6 -40 -28 31z M180 345 l-25 -28 7 40z M1035 455 l24 -28 -7 40z"/>
                </g>
            </svg>
        </div>
        {ended && <><div className="rf-boss-end"><div className="rf-boss-panel">
            <h1 className="rf-boss-title">{view.phase === 'victory' ? 'PUMPLE DEFEATED!' : 'RECFLARE HAS FALLEN'}</h1>
            <p>{view.phase === 'victory' ? 'The pumpkin king crumbles into embers. The vines retreat and RecFlare is saved!' : 'The vines have consumed the battlefield. Pumple claims RecFlare...'}</p>
            {view.phase === 'victory' && <p>Waves reached: {view.waves} · Minions defeated: {view.kills} · Bombs remaining: {view.bombs}</p>}
            {view.phase === 'victory' && <button className="rf-boss-button" onClick={e => { e.stopPropagation(); setActive(false); started.current = false }}>RETURN TO RECFLARE</button>}
            {view.phase === 'defeat' && <p>The site will reset after the vines take over...</p>}
        </div></div></>}
    </div>
}
