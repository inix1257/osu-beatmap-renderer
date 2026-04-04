import { PathPoint } from './PathPoint.js';

export class Bezier {
    constructor() {
        this.arrPn = [];
        this.mu = 0;
        this.resultPoint = new PathPoint();
        this.initResultPoint();
        this.arcLength = 0;
        this.arcLengthTable = [];
    }

    setBezierN(arrPn) {
        this.arrPn = arrPn.slice();
        this.calculateArcLength();
    }

    bezierCalc() {
        let k, kn, nn, nkn;
        let blend, muk, munk;
        const n = this.arrPn.length - 1;

        this.initResultPoint();
        muk = 1;
        munk = Math.pow(1 - this.mu, n);
        for (k = 0; k <= n; k++) {
            nn = n;
            kn = k;
            nkn = n - k;
            blend = muk * munk;
            muk *= this.mu;
            munk /= (1 - this.mu);
            while (nn >= 1) {
                blend *= nn;
                nn--;
                if (kn > 1) {
                    blend /= kn;
                    kn--;
                }
                if (nkn > 1) {
                    blend /= nkn;
                    nkn--;
                }
            }
            this.resultPoint.x += this.arrPn[k].x * blend;
            this.resultPoint.y += this.arrPn[k].y * blend;
        }
    }

    initResultPoint() {
        this.resultPoint.x = 0.0;
        this.resultPoint.y = 0.0;
    }

    setMu(mu) {
        this.mu = mu;
    }

    getResult() {
        return this.resultPoint;
    }

    calculateArcLength() {
        this.arcLength = 0;
        this.arcLengthTable = [];
        let prevPoint = this.arrPn[0];
        for (let t = 0; t <= 1; t += 0.01) {
            this.setMu(t);
            this.bezierCalc();
            const currPoint = this.getResult();
            const segmentLength = Math.sqrt(Math.pow(currPoint.x - prevPoint.x, 2) + Math.pow(currPoint.y - prevPoint.y, 2));
            this.arcLength += segmentLength;
            this.arcLengthTable.push({ t, length: this.arcLength });
            prevPoint = { ...currPoint };
        }
    }

    getMuForArcLength(targetLength) {
        for (let i = 0; i < this.arcLengthTable.length - 1; i++) {
            const curr = this.arcLengthTable[i];
            const next = this.arcLengthTable[i + 1];
            if (targetLength >= curr.length && targetLength <= next.length) {
                const ratio = (targetLength - curr.length) / (next.length - curr.length);
                return curr.t + ratio * (next.t - curr.t);
            }
        }
        return 1;
    }
}
