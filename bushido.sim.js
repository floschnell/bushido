class MathHelpers { }

MathHelpers.interpolate = (speed, min, max) => {
    return max - Math.max(0, 50 - speed) / 50 * (max - min);
};

MathHelpers.toRadians = (degrees) => {
    return degrees * Math.PI / 180;
};

MathHelpers.toDegrees = (radians) => {
    return radians * 180 / Math.PI;
};

MathHelpers.bearing = (startLat, startLng, destLat, destLng) => {
    startLat = MathHelpers.toRadians(startLat);
    startLng = MathHelpers.toRadians(startLng);
    destLat = MathHelpers.toRadians(destLat);
    destLng = MathHelpers.toRadians(destLng);

    y = Math.sin(destLng - startLng) * Math.cos(destLat);
    x = Math.cos(startLat) * Math.sin(destLat) -
        Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
    brng = Math.atan2(y, x);
    brng = MathHelpers.toDegrees(brng);
    return (brng + 360) % 360;
}


class BushidoSimulator {

    constructor(bushidoConnection, {
        gpxFileInputId,
        overlayElementId,
        gameElementId,
        mapElementId,
        startElementId,
        pauseElementId,
        forwardButtonId,
        rewindButtonId,
    }) {
        this.cameraRotation = 0;
        this.offset = 0;
        this.player = null;
        this.cesiumViewer = null;
        this.smoothedSegments = [];
        this.progressedDistance = 0;
        this.subprogress = 0;
        this.lastRender = performance.now();
        this.bushidoConnection = bushidoConnection;

        if (this.bushidoConnection != null) {
            this.bushidoConnection.onDataUpdated = this.onDataUpdated.bind(this);
            this.bushidoConnection.onPaused = this.onPaused.bind(this);
            this.bushidoConnection.onResumed = this.onResumed.bind(this);
            this.bushidoConnection.onDistanceUpdated = this.onDistanceUpdated.bind(this);
        }

        this.gpxFileInput = document.getElementById(gpxFileInputId);
        this.overlayElement = document.getElementById(overlayElementId);
        this.gameElement = document.getElementById(gameElementId);
        this.mapElement = document.getElementById(mapElementId);
        this.startElement = document.getElementById(startElementId);
        this.pauseElement = document.getElementById(pauseElementId);

        document.getElementById(forwardButtonId).onclick = () => this.seek(1000);
        document.getElementById(rewindButtonId).onclick = () => this.seek(-1000);

        this.startElement.onclick = () => this.start();
    }

    seek(value) {
        this.offset += value;
        this.onDistanceUpdated(this.bushidoConnection.getData().distance);
    }

    async start() {
        const files = this.gpxFileInput.files;
        if (files.length === 1) {
            try {
                const gpxFile = files.item(0);

                const gpxData = await this._readTextFile(gpxFile);
                const parser = new gpxParser();
                parser.parse(gpxData);
                this.smoothedSegments = this._smooth(parser);

                await this.bushidoConnection.init();

                this.gameElement.style.display = "flex";
                this.startElement.style.display = "none";

                const [viewer, entity] = this._initMap(parser);
                this.player = entity;
                this.cesiumViewer = viewer;
                this._renderLoop();

                this.onDistanceUpdated(0);
                this.onPaused();
                this.onDataUpdated(new BushidoData());

                await this.bushidoConnection.run();
            } catch (e) {
                console.error(e);
            }
        }
    }

    onDataUpdated(bushidoData) {
        this.overlayElement.innerHTML = `Speed: ${Math.round(bushidoData.speed * 10) / 10} km/h<br />Cadence: ${bushidoData.cadence}<br />Power: ${bushidoData.power} Watt<br />Distance: ${Math.round((bushidoData.distance + this.offset) / 10) / 100} km (${Math.round((bushidoData.distance + this.offset) * 1000 / (this.smoothedSegments.length * 20)) / 10}%)<br />Slope: ${Math.round(bushidoData.slope * 10) / 10}%`;
    }

    onPaused() {
        this.pauseElement.style.display = "block";
    }

    onResumed() {
        this.pauseElement.style.display = "none";
    }

    onDistanceUpdated(distance) {
        const { slope } = this.bushidoConnection.getData();
        const corrected_distance = distance + this.offset;
        const nextIndex = Math.ceil(corrected_distance / 20);
        const nextSegment = this.smoothedSegments[nextIndex];

        console.log("next segment", nextSegment);
        if (nextSegment !== undefined) {
            const nextSlope = Math.max(Math.min(nextSegment.slope, slope + BushidoSimulator.MAX_SLOPE_CHANGE), slope - BushidoSimulator.MAX_SLOPE_CHANGE);
            this.bushidoConnection.setSlope(nextSlope);
            console.log("sent new slope of", nextSlope);
        }

        this.subprogress = 0;
        this.progressedDistance = corrected_distance;
        console.log("distance now at", corrected_distance);
        this._drawChart(nextIndex);
    }

    async _readTextFile(file) {
        const reader = new FileReader();
        const promisedResult = new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = (e) => reject(e);
        });
        reader.readAsText(file);
        return promisedResult;
    }

    _initMap(gpx) {

        const viewer = new Cesium.Viewer('map', {
            terrainProvider: Cesium.createWorldTerrain(),
            baseLayerPicker: false,
            fullscreenButton: false,
            vrButton: false,
            homeButton: false,
            infoBox: false,
            sceneModePicker: false,
            timeline: false,
            navigationHelpButton: false,
            animation: false,
        });

        const position = Cesium.Cartesian3.fromDegrees(-123.0744619, 44.0503706, 0);
        const heading = Cesium.Math.toRadians(135);
        const orientation = Cesium.Transforms.headingPitchRollQuaternion(position, new Cesium.HeadingPitchRoll(heading, 0, 0));

        const entity = viewer.entities.add({
            name: "bike",
            position: position,
            orientation: orientation,
            model: {
                scale: 4,
                uri: './bike.glb',
                color: Cesium.Color.WHITE,
                silhouetteColor: Cesium.Color.ORANGE,
                silhouetteSize: 2,
            },
        });

        const degreeArr = gpx.tracks[0].points
            .map((p) => [p.lon, p.lat])
            .reduce((prev, cur) => prev.concat(cur), []);

        const polyline = new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(degreeArr),
            width: 10,
        });

        const geometryInstance = new Cesium.GeometryInstance({
            geometry: polyline,
            id: 'path',
            attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.ORANGE)
            },
        });

        viewer.scene.groundPrimitives.add(
            new Cesium.GroundPolylinePrimitive({
                geometryInstances: geometryInstance,
                appearance: new Cesium.PolylineColorAppearance()
            })
        );

        return [viewer, entity];
    }

    _drawChart(index) {
        const buffer = Math.round(1000 / 20);
        const currentSegments = this.smoothedSegments.slice(Math.max(0, index - buffer), Math.min(this.smoothedSegments.length, index + buffer + 1));
        const bufferArrLeft = new Array(index - Math.max(0, index - buffer)).fill(null);
        const bufferArrRight = new Array(Math.min(this.smoothedSegments.length, index + buffer) - index).fill(null);
        const data = {
            labels: currentSegments.map(s => `${Math.round(s.distance / 1000)}`),
            series: [currentSegments.map(s => s.elevation), bufferArrLeft.concat([this.smoothedSegments[index].elevation]).concat(bufferArrRight)],
        };

        const chart = new Chartist.Line('#chart', data, {
            axisX: {},
            axisY: {
                onlyInteger: true,
            }
        }, {});
    }

    async _renderLoop() {
        const bushidoData = this.bushidoConnection.getData();
        const viewerDist = MathHelpers.interpolate(bushidoData.speed, 200, 300);
        const viewerHeight = MathHelpers.interpolate(bushidoData.speed, 30, 100);
        const meterPerSecond = bushidoData.speed / 3.6;
        const deltaT = performance.now() - this.lastRender;
        this.lastRender = performance.now();
        this.subprogress += deltaT / 1000 * meterPerSecond;

        const nextIndex = Math.ceil((this.progressedDistance + this.subprogress) / 20);
        const nextSegment = this.smoothedSegments[nextIndex];
        const prevSegment = nextIndex > 0 ? this.smoothedSegments[nextIndex - 1] : nextSegment;

        const playerPosition = this._getPos();
        const playerRotation = MathHelpers.bearing(prevSegment.lat, prevSegment.lng, nextSegment.lat, nextSegment.lng);
        const playerCartographic = Cesium.Cartographic.fromDegrees(playerPosition.longitude, playerPosition.latitude);
        Cesium.sampleTerrainMostDetailed(this.cesiumViewer.terrainProvider, [playerCartographic]).then(([terrainUnderPlayer]) => {

            const playerFixed = Cesium.Cartesian3.fromDegrees(playerPosition.longitude, playerPosition.latitude, terrainUnderPlayer.height);
            const heading = Cesium.Math.toRadians(playerRotation);
            const orientation = Cesium.Transforms.headingPitchRollQuaternion(playerFixed, new Cesium.HeadingPitchRoll(heading, 0, 0));

            this.player.orientation = orientation;
            this.player.position = playerFixed;

            const localToFixed = Cesium.Transforms.localFrameToFixedFrameGenerator("east", "north")(playerFixed);
            
            const cameraTarget = (Math.PI * 2 - heading + Math.PI * 1.5) % (Math.PI * 2);
            const leftRotationDistance = cameraTarget > this.cameraRotation ? cameraTarget - this.cameraRotation : Math.PI * 2 - this.cameraRotation + cameraTarget;
            const rightRotationDistance = cameraTarget < this.cameraRotation ? this.cameraRotation - cameraTarget : this.cameraRotation + Math.PI * 2 - cameraTarget;

            if (leftRotationDistance < rightRotationDistance) {
                if (leftRotationDistance > Math.PI / 180) {
                    this.cameraRotation += Math.sqrt(leftRotationDistance) / 100;
                }
            } else {
                if (rightRotationDistance > Math.PI / 180) {
                    this.cameraRotation -= Math.sqrt(rightRotationDistance) / 100;
                }
            }
            this.cameraRotation = (this.cameraRotation + Math.PI * 2) % (Math.PI * 2);
            const s = Math.sin(this.cameraRotation);
            const c = Math.cos(this.cameraRotation);
            const camLocal = new Cesium.Cartesian3(viewerDist * c, viewerDist * s, 0);
            const camFixed = new Cesium.Cartesian3();
            Cesium.Matrix4.multiplyByPointAsVector(localToFixed, camLocal, camFixed);

            const camFixedWorld = new Cesium.Cartesian3();
            Cesium.Cartesian3.add(camFixed, playerFixed, camFixedWorld);
            const camCartographic = Cesium.Cartographic.fromCartesian(camFixedWorld);

            Cesium.sampleTerrainMostDetailed(this.cesiumViewer.terrainProvider, [camCartographic]).then(([terrainUnderCam]) => {
                const correctedHeight = terrainUnderCam.height < terrainUnderPlayer.height ? viewerHeight : terrainUnderCam.height + viewerHeight - terrainUnderPlayer.height;
                const camCorrectedHeight = new Cesium.Cartesian3(viewerDist * c, viewerDist * s, correctedHeight);
                this.cesiumViewer.camera.lookAt(playerFixed, camCorrectedHeight);
            });
        });

        Cesium.requestAnimationFrame(this._renderLoop.bind(this));
    }

    _smooth(gpx) {
        const segments = gpx.tracks[0].points.map((p, i) => ({
            distance: i > 0 ? gpx.tracks[0].distance.cumul[i - 1] : 0,
            slope: i > 0 ? gpx.tracks[0].slopes[i - 1] : 0,
            ...p,
        })).filter((s) => s.slope !== Infinity && s.slope !== -Infinity);

        let x = 0;
        const interval = 20.0;
        let i = 0;
        let current = null;
        let prev = undefined;
        const smoothedSegments = [];
        const num_neighbours = 5;
        for (x = 0; x < gpx.tracks[0].distance.total; x += interval) {
            for (; i < segments.length; i++) {
                if (segments[i].distance >= x) {
                    current = segments[i];
                    prev = i > 0 ? segments[i - 1] : undefined;
                    if (prev !== undefined) {
                        const coveredDistance = current.distance - prev.distance;
                        const deltaElevation = current.ele - prev.ele;
                        const deltaLat = current.lat - prev.lat;
                        const deltaLng = current.lon - prev.lon;
                        const overshot = x - prev.distance;
                        current = {
                            distance: x,
                            slope: ((overshot / coveredDistance) * deltaElevation) / overshot * 100.0,
                            lat: prev.lat + (overshot / coveredDistance) * deltaLat,
                            lon: prev.lon + (overshot / coveredDistance) * deltaLng,
                        };
                    }

                    const left = Math.max(0, smoothedSegments.length - num_neighbours);
                    const elements = smoothedSegments.slice(left, smoothedSegments.length).concat([current]);

                    const mean = elements.reduce((prev, current) => prev + current.slope, 0) / elements.length;

                    smoothedSegments.push({
                        distance: x,
                        slope: mean,
                        elevation: smoothedSegments.length > 0 ? smoothedSegments[smoothedSegments.length - 1].elevation + mean / 100.0 * interval : segments[0].ele,
                        lat: current.lat,
                        lng: current.lon,
                    });
                    break;
                }
            }
        }

        let warnings = 0;
        smoothedSegments.forEach((v, i) => {
            if (i > 0) {
                if (v.slope - smoothedSegments[i - 1].slope > 1) {
                    console.log("warning:", smoothedSegments[i - 1], v);
                    warnings++;
                }
            }
        });

        console.log("warnings:", warnings);
        console.log(smoothedSegments);

        console.log(smoothedSegments.map(s => `${s.distance};${s.elevation}`).join("\n"))

        return smoothedSegments;
    }

    _getPos() {
        const nextIndex = Math.ceil((this.progressedDistance + this.subprogress) / 20);
        const nextSegment = this.smoothedSegments[nextIndex];
        const prevSegment = nextIndex > 0 ? this.smoothedSegments[nextIndex - 1] : undefined;

        if (prevSegment === undefined) {
            return {
                latitude: nextSegment.lat,
                longitude: nextSegment.lng,
            };
        } else {
            const coveredDistance = nextSegment.distance - prevSegment.distance;
            const percent = ((this.progressedDistance + this.subprogress) - prevSegment.distance) / coveredDistance;

            return {
                latitude: prevSegment.lat + (nextSegment.lat - prevSegment.lat) * percent,
                longitude: prevSegment.lng + (nextSegment.lng - prevSegment.lng) * percent,
            };
        }
    }
}

BushidoSimulator.MAX_SLOPE_CHANGE = 1.0;