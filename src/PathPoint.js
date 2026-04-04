export class PathPoint {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }

    static compare(point1, point2) {
        return point1.x === point2.x && point1.y === point2.y;
    }
}
