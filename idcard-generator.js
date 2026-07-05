/**
 * idcard-generator.js
 * ─────────────────────────────────────────────────────────────────
 * Adds a "Download ID Card" button to every student card on the page
 * and, on click, renders a nicely laid-out student ID card as a PNG
 * (drawn on a <canvas>) and downloads it.
 *
 * This file is fully self-contained: it reads whatever it needs
 * straight out of the rendered card DOM (name, roll, hometown,
 * interest, focus, photo) so it keeps working even if the roster is
 * re-rendered (search/filter/sort) or students.json changes shape.
 *
 * Common line printed on every card (as requested):
 *   "Dept. Of CSE, Netrokona University"
 */
(function () {
    'use strict';

    const COMMON_DEPT_LINE = 'Dept. Of CSE, Netrokona University';
    const UNIVERSITY_NAME  = 'NETROKONA UNIVERSITY';
    const BATCH_LINE       = 'B.Sc. in CSE — 7th Batch';
    const SITE_TAG         = 'cse.neub.edu.bd';

    // ── Inject button styles (kept in this file so index.html only
    //    needs the single <script src="idcard-generator.js"> tag) ──
    const style = document.createElement('style');
    style.textContent = `
        .idcard-actions-wrap {
            display: flex;
            align-items: center;
            gap: var(--space-2, 8px);
        }
        .idcard-download-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            flex-shrink: 0;
            background: var(--gold-glow, rgba(245, 158, 11, 0.1));
            border: 1px solid rgba(245, 158, 11, 0.35);
            color: var(--gold, #f59e0b);
            border-radius: var(--radius-sm, 8px);
            cursor: pointer;
            transition: all var(--speed-fast, 200ms);
        }
        .idcard-download-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
        .idcard-download-btn:hover, .idcard-download-btn:focus-visible {
            background: rgba(245, 158, 11, 0.2);
            border-color: var(--gold, #f59e0b);
            box-shadow: 0 4px 12px -2px var(--gold-glow, rgba(245, 158, 11, 0.35));
            transform: translateY(-2px);
            outline: none;
        }
        .idcard-download-btn.is-generating {
            opacity: 0.55;
            pointer-events: none;
        }
        .idcard-download-btn .idcard-spin {
            animation: idcard-spin 0.8s linear infinite;
            transform-origin: center;
        }
        @keyframes idcard-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);

    const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    const SPINNER_ICON  = `<svg class="idcard-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

    // ── Pull the data we need straight from the rendered card ──────────
    function extractStudentDataFromCard(card) {
        const nameEn = (card.querySelector('.stu-name')?.textContent || 'Unknown').trim();
        const nameBn = (card.querySelector('.stu-name-bn')?.textContent || '').trim();
        const roll = (card.dataset.roll || card.querySelector('.roll-badge')?.textContent || '').trim();
        const hometown = (card.querySelector('.stu-hometown')?.textContent || '').trim();

        let interest = '';
        let subject = '';
        card.querySelectorAll('.card-stats-rows .stat-row').forEach(row => {
            const label = row.querySelector('span')?.textContent.trim();
            const value = row.querySelector('b')?.textContent.trim() || '';
            if (label === 'Interest') interest = value;
            if (label === 'Focus') subject = value;
        });

        const imgEl = card.querySelector('.student-image');
        const hasVisibleImg = imgEl && imgEl.style.display !== 'none';

        return {
            nameEn, nameBn, roll, hometown, interest, subject,
            imgSrc: hasVisibleImg ? imgEl.src : null
        };
    }

    function loadImage(src) {
        return new Promise((resolve) => {
            if (!src) { resolve(null); return; }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // Draws an image "cover"-style into a target box (like CSS object-fit: cover)
    function drawImageCover(ctx, img, x, y, w, h) {
        const scale = Math.max(w / img.width, h / img.height);
        const sw = w / scale;
        const sh = h / scale;
        const sx = (img.width - sw) / 2;
        const sy = (img.height - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }

    // Small deterministic PRNG (seeded from the roll number) so the
    // decorative barcode looks the same every time a given card is
    // re-downloaded, rather than jittering randomly.
    function makeSeededRandom(seedStr) {
        let seed = 0;
        for (let i = 0; i < seedStr.length; i++) seed += seedStr.charCodeAt(i) * (i + 1);
        return function () {
            seed = (seed * 9301 + 49297) % 233280;
            return seed / 233280;
        };
    }

    async function generateIdCardCanvas(student) {
        if (document.fonts && document.fonts.ready) {
            try { await document.fonts.ready; } catch (e) { /* ignore */ }
        }

        const W = 640, H = 1020;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        // Outer rounded card + clip everything inside it
        roundRectPath(ctx, 0, 0, W, H, 28);
        ctx.fillStyle = '#0b1120';
        ctx.fill();

        ctx.save();
        roundRectPath(ctx, 3, 3, W - 6, H - 6, 25);
        ctx.clip();

        // Base background
        const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#111827');
        bgGrad.addColorStop(1, '#070a12');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        // ── Header band ──
        const headerH = 196;
        const headerGrad = ctx.createLinearGradient(0, 0, W, headerH);
        headerGrad.addColorStop(0, '#312e81');
        headerGrad.addColorStop(1, '#4c1d95');
        ctx.fillStyle = headerGrad;
        ctx.fillRect(0, 0, W, headerH);

        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(0, headerH, W, 6);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 30px "Space Grotesk", sans-serif';
        ctx.fillText(UNIVERSITY_NAME, W / 2, 64);

        ctx.font = '500 19px "Inter", sans-serif';
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(COMMON_DEPT_LINE, W / 2, 96);

        ctx.font = '600 15px "JetBrains Mono", monospace';
        ctx.fillStyle = '#fcd34d';
        ctx.fillText('STUDENT IDENTITY CARD', W / 2, 133);

        ctx.font = '400 15px "Inter", sans-serif';
        ctx.fillStyle = 'rgba(248,250,252,0.75)';
        ctx.fillText(BATCH_LINE, W / 2, 165);

        // ── Photo ──
        const photoSize = 220;
        const photoX = (W - photoSize) / 2;
        const photoY = headerH + 42;

        roundRectPath(ctx, photoX - 7, photoY - 7, photoSize + 14, photoSize + 14, 22);
        ctx.fillStyle = '#f59e0b';
        ctx.fill();

        ctx.save();
        roundRectPath(ctx, photoX, photoY, photoSize, photoSize, 16);
        ctx.clip();
        if (student.imgObj) {
            drawImageCover(ctx, student.imgObj, photoX, photoY, photoSize, photoSize);
        } else {
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(photoX, photoY, photoSize, photoSize);
            ctx.fillStyle = '#a78bfa';
            ctx.font = '700 72px "Space Grotesk", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const initials = student.nameEn.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
            ctx.fillText(initials, photoX + photoSize / 2, photoY + photoSize / 2);
            ctx.textBaseline = 'alphabetic';
        }
        ctx.restore();

        let curY = photoY + photoSize + 58;

        // ── Name ──
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 33px "Space Grotesk", sans-serif';
        ctx.fillText(student.nameEn, W / 2, curY);
        curY += 8;

        if (student.nameBn) {
            curY += 34;
            ctx.font = '600 23px "Noto Sans Bengali", sans-serif';
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(student.nameBn, W / 2, curY);
        }
        curY += 52;

        // Roll pill
        const rollText = `Roll: ${student.roll}`;
        ctx.font = '700 18px "JetBrains Mono", monospace';
        const rollWidth = ctx.measureText(rollText).width + 50;
        roundRectPath(ctx, W / 2 - rollWidth / 2, curY - 27, rollWidth, 40, 20);
        ctx.fillStyle = 'rgba(139,92,246,0.18)';
        ctx.fill();
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#c4b5fd';
        ctx.fillText(rollText, W / 2, curY);
        curY += 52;

        // Divider
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(60, curY);
        ctx.lineTo(W - 60, curY);
        ctx.stroke();
        curY += 42;

        // ── Info rows ──
        const infoRows = [
            { label: 'HOMETOWN', value: student.hometown },
            { label: 'INTEREST', value: student.interest },
            { label: 'FOCUS',    value: student.subject }
        ].filter(r => r.value);

        const rowGap = 60;
        infoRows.forEach((row, i) => {
            const y = curY + i * rowGap;
            ctx.textAlign = 'left';
            ctx.font = '600 13px "JetBrains Mono", monospace';
            ctx.fillStyle = '#f59e0b';
            ctx.fillText(row.label, 70, y);
            ctx.font = '500 21px "Inter", sans-serif';
            ctx.fillStyle = '#f1f5f9';
            ctx.fillText(row.value, 70, y + 27);
        });

        // ── Footer ──
        const footerH = 92;
        const footerY = H - footerH;
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(0, footerY, W, footerH);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(0, footerY);
        ctx.lineTo(W, footerY);
        ctx.stroke();

        // Decorative barcode, seeded from the roll number
        const rand = makeSeededRandom(String(student.roll || student.nameEn));
        let bx = 70;
        const barcodeY = footerY + 24;
        const barcodeH = 42;
        ctx.fillStyle = '#94a3b8';
        while (bx < 300) {
            const bw = 2 + Math.floor(rand() * 3);
            ctx.fillRect(bx, barcodeY, bw, barcodeH);
            bx += bw + 2 + Math.floor(rand() * 4);
        }

        ctx.textAlign = 'right';
        ctx.font = '600 14px "Inter", sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText('Netrokona University', W - 70, footerY + 40);
        ctx.font = '400 12px "JetBrains Mono", monospace';
        ctx.fillStyle = '#64748b';
        ctx.fillText(SITE_TAG, W - 70, footerY + 62);

        ctx.restore(); // lift outer clip
        return canvas;
    }

    function filenameFor(data) {
        const safeName = data.nameEn.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'student';
        const safeRoll = (data.roll || '').replace(/[^a-z0-9]+/gi, '') || 'roll';
        return `IDCard_${safeRoll}_${safeName}.png`;
    }

    function triggerDownloadFromUrl(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function triggerDownloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        triggerDownloadFromUrl(url, filename);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    async function handleDownloadClick(card, btn) {
        const originalHtml = btn.innerHTML;
        btn.classList.add('is-generating');
        btn.innerHTML = SPINNER_ICON;
        try {
            const data = extractStudentDataFromCard(card);
            const imgObj = await loadImage(data.imgSrc);
            const canvas = await generateIdCardCanvas({ ...data, imgObj });

            await new Promise((resolve) => {
                canvas.toBlob((blob) => {
                    if (blob) {
                        triggerDownloadBlob(blob, filenameFor(data));
                    } else {
                        // toBlob failed silently (rare) — fall back to a data URL
                        triggerDownloadFromUrl(canvas.toDataURL('image/png'), filenameFor(data));
                    }
                    resolve();
                }, 'image/png');
            });
        } catch (err) {
            console.error('ID card generation failed:', err);
            alert('ID card ta banano gelo na — sombhoboto chhobi ta emon jaygay hosted jekhane canvas export kora jay na. Abar cheshta korun.');
        } finally {
            btn.classList.remove('is-generating');
            btn.innerHTML = originalHtml;
        }
    }

    function addDownloadButtonToCard(card) {
        const foot = card.querySelector('.card-foot');
        if (!foot || foot.querySelector('.idcard-download-btn')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'idcard-download-btn';
        btn.innerHTML = DOWNLOAD_ICON;
        btn.title = 'Download ID Card (PNG)';
        btn.setAttribute('aria-label', 'Download student ID card as PNG image');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleDownloadClick(card, btn);
        });
        btn.addEventListener('keydown', (e) => e.stopPropagation());

        // Group it together with the existing "Profile" button so the
        // card-foot keeps its original two-slot (actions | socials) layout.
        const profileBtn = foot.querySelector('.profile-btn');
        if (profileBtn) {
            let wrap = foot.querySelector('.idcard-actions-wrap');
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.className = 'idcard-actions-wrap';
                foot.insertBefore(wrap, profileBtn);
                wrap.appendChild(profileBtn);
            }
            wrap.appendChild(btn);
        } else {
            foot.appendChild(btn);
        }
    }

    function scanAndAttach() {
        document.querySelectorAll('#studentGrid .card').forEach(addDownloadButtonToCard);
    }

    function init() {
        const grid = document.getElementById('studentGrid');
        if (!grid) return;

        scanAndAttach();

        // The roster is fully re-rendered (innerHTML cleared + rebuilt)
        // on every search / filter / sort change, so new card elements
        // keep getting created — watch for that and re-attach.
        const observer = new MutationObserver(scanAndAttach);
        observer.observe(grid, { childList: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
