import * as PIXI from 'pixi.js';
import { PathPoint } from './PathPoint.js';
import { Bezier } from './Bezier.js';
import { getCircleCenter } from './utils.js';

export function getReverseArrowAngle(sliderInfo) {
  const anchorPositions = sliderInfo.anchorPositions;
  const endPos = sliderInfo.sliderEndPos;
  if (!anchorPositions || anchorPositions.length < 2 || !endPos) {
    return 0;
  }
  const secondLastPoint = anchorPositions[Math.max(0, anchorPositions.length - 2)];
  return Math.atan2(secondLastPoint.y - endPos.y, secondLastPoint.x - endPos.x) + Math.PI;
}

export function bezierCurve(sliderInfo, layout) {
  const anchorPositions = sliderInfo.anchorPositions;
  if (!sliderInfo.adjusted) {
    adjustAnchorPositions(anchorPositions, layout);
    sliderInfo.adjusted = true;
  }

  const sliderTotalLength = Number(sliderInfo.sliderLength) * layout.gridUnit;
  let totalLength = 0;

  let arrPn = [new PathPoint(anchorPositions[0].x, anchorPositions[0].y)];
  let bezier = new Bezier();
  const sliderPath = new PIXI.Graphics();
  sliderPath.moveTo(anchorPositions[0].x, anchorPositions[0].y);

  for (let i = 1; i < anchorPositions.length; i++) {
    const prevPos = anchorPositions[i - 1];
    const currPos = anchorPositions[i];
    if (i === anchorPositions.length - 1 || PathPoint.compare(prevPos, currPos)) {
      if (i === anchorPositions.length - 1) {
        arrPn.push(new PathPoint(anchorPositions[i].x, anchorPositions[i].y));
      }
      bezier.setBezierN(arrPn);

      const muGap = 10 / Math.max(1, sliderTotalLength);
      const startP = new PathPoint();
      const endP = new PathPoint();

      for (let mu = 0; mu <= 1; mu += muGap) {
        startP.x = bezier.getResult().x;
        startP.y = bezier.getResult().y;

        bezier.setMu(mu);
        bezier.bezierCalc();

        endP.x = bezier.getResult().x;
        endP.y = bezier.getResult().y;

        sliderInfo.sliderEndPos = startP;
        if (Number.isFinite(endP.x) && Number.isFinite(endP.y)) {
          sliderPath.lineTo(endP.x, endP.y);
          sliderInfo.sliderEndPos = endP;
        }

        if (mu === 0) continue;
        totalLength += Math.hypot(startP.x - endP.x, startP.y - endP.y);

        if (totalLength >= sliderTotalLength) break;
      }

      arrPn = [];
      bezier = new Bezier();

      if (i < anchorPositions.length - 1) {
        arrPn.push(new PathPoint(prevPos.x, prevPos.y));
      } else {
        arrPn.push(new PathPoint(currPos.x, currPos.y));
      }
    }

    arrPn.push(new PathPoint(anchorPositions[i].x, anchorPositions[i].y));
  }

  return sliderPath;
}

export function perfectCurve(sliderInfo, layout) {
  const anchorPositions = sliderInfo.anchorPositions;
  if (!sliderInfo.adjusted) {
    adjustAnchorPositions(anchorPositions, layout);
    sliderInfo.adjusted = true;
  }

  const sliderTotalLength = Number(sliderInfo.sliderLength) * layout.gridUnit;
  let totalLength = 0;
  const sliderPath = new PIXI.Graphics();
  sliderPath.moveTo(anchorPositions[0].x, anchorPositions[0].y);

  const circleCenter = getCircleCenter(anchorPositions[0], anchorPositions[1], anchorPositions[2]);
  const radius = Math.hypot(circleCenter.x - anchorPositions[0].x, circleCenter.y - anchorPositions[0].y);

  const angleA = Math.atan2(anchorPositions[0].y - circleCenter.y, anchorPositions[0].x - circleCenter.x);
  const angleC = Math.atan2(anchorPositions[2].y - circleCenter.y, anchorPositions[2].x - circleCenter.x);

  const yDeltaA = anchorPositions[1].y - anchorPositions[0].y;
  const xDeltaA = anchorPositions[1].x - anchorPositions[0].x;
  const yDeltaB = anchorPositions[2].y - anchorPositions[1].y;
  const xDeltaB = anchorPositions[2].x - anchorPositions[1].x;

  const anticlockwise = xDeltaB * yDeltaA - xDeltaA * yDeltaB > 0;

  const startAngle = angleA;
  let endAngle = angleC;
  if (!anticlockwise && endAngle - startAngle < 0) endAngle += Math.PI * 2;
  if (anticlockwise && endAngle - startAngle > 0) endAngle -= Math.PI * 2;

  const angleStep = (endAngle - startAngle) / 100;

  let prevX;
  let prevY;

  for (let i = 0; i <= 100; i++) {
    const angle = startAngle + angleStep * i;
    const x = circleCenter.x + radius * Math.cos(angle);
    const y = circleCenter.y + radius * Math.sin(angle);
    sliderPath.lineTo(x, y);

    if (i !== 0) {
      totalLength += Math.hypot(x - prevX, y - prevY);
      if (totalLength >= sliderTotalLength) {
        prevX = x;
        prevY = y;
        break;
      }
    }

    prevX = x;
    prevY = y;
  }

  sliderInfo.sliderEndPos = { x: prevX, y: prevY };
  return sliderPath;
}

function adjustAnchorPositions(anchorPositions, layout) {
  for (const anchor of anchorPositions) {
    anchor.x = layout.topLeftX + anchor.x * layout.gridUnit;
    anchor.y = layout.topLeftY + anchor.y * layout.gridUnit;
  }
}
