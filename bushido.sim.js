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


const CHART_METRICS = [
    {
        id: "speed",
        color: "green",
        datasetIndex: 1,
    },
    {
        id: "cadence",
        color: "blue",
        datasetIndex: 2,
    },
    {
        id: "power",
        color: "red",
        datasetIndex: 3,
    },
];


function download(filename, json) {
    const element = document.createElement("a");
    element.setAttribute(
        "href",
        "data:application/xml;charset=utf-8," + encodeURIComponent(json)
    );
    element.setAttribute("download", filename);

    element.style.display = "none";
    document.body.appendChild(element);

    element.click();

    document.body.removeChild(element);
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
        this.recording = [];
        this.activeChartMetric = 1;

        if (this.bushidoConnection != null) {
            this.bushidoConnection.onDataUpdated = this.onDataUpdated.bind(this);
            this.bushidoConnection.onPaused = this.onPaused.bind(this);
            this.bushidoConnection.onResumed = this.onResumed.bind(this);
            this.bushidoConnection.onDistanceUpdated = this.onDistanceUpdated.bind(this);
            this.bushidoConnection.onButtonDown = this.onButtonDown.bind(this);
            this.bushidoConnection.onButtonUp = this.onButtonUp.bind(this);
            this.bushidoConnection.onButtonRight = this.onButtonRight.bind(this);
            this.bushidoConnection.onButtonLeft = this.onButtonLeft.bind(this);
        }

        this.gpxFileInput = document.getElementById(gpxFileInputId);
        this.overlayElement = document.getElementById(overlayElementId);
        this.gameElement = document.getElementById(gameElementId);
        this.mapElement = document.getElementById(mapElementId);
        this.startElement = document.getElementById(startElementId);
        this.pauseElement = document.getElementById(pauseElementId);
        this.overlayPausedElement = document.getElementById("overlay-paused");

        document.getElementById(forwardButtonId).onclick = () => this.seek(1000);
        document.getElementById(rewindButtonId).onclick = () => this.seek(-1000);

        this.startElement.onclick = () => this.start();

        this.chart = new Chart(document.getElementById("chart"), {
            type: 'line',
            data: {
                datasets: [{
                    label: "Elevation",
                    data: [],
                    borderColor: 'grey',
                    yAxisID: 'y-axis-elevation',
                },
                {
                    label: "Geschwindigkeit",
                    data: [],
                    borderColor: 'green',
                    fill: false,
                    yAxisID: 'y-axis-metrics',
                },
                {
                    label: "Kadenz",
                    data: [],
                    borderColor: 'blue',
                    fill: false,
                    yAxisID: 'y-axis-metrics',
                },
                {
                    label: "Watt",
                    data: [],
                    borderColor: 'red',
                    fill: false,
                    yAxisID: 'y-axis-metrics',
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    xAxes: [{
                        type: 'linear',
                        position: 'bottom',
                        ticks: {
                            min: 0,
                            max: 1000,
                        },
                    }],
                    yAxes: [{
                        type: 'linear', // only linear but allow scale type registration. This allows extensions to exist solely for log scale for instance
                        display: true,
                        position: 'left',
                        id: 'y-axis-elevation',
                    }, {
                        type: 'linear', // only linear but allow scale type registration. This allows extensions to exist solely for log scale for instance
                        display: true,
                        position: 'right',
                        id: 'y-axis-metrics',
                        ticks: {
                            beginAtZero: true,
                        },

                        // grid line settings
                        gridLines: {
                            drawOnChartArea: false, // only want the grid lines for one axis to show up
                        },
                    }],
                },
            },
        });
    }

    onButtonDown() {
        this.activeChartMetric = ((this.activeChartMetric - 1 + CHART_METRICS.length) % CHART_METRICS.length) + 1;
    }
    
    onButtonUp() {
        this.activeChartMetric = ((this.activeChartMetric + 1 + CHART_METRICS.length) % CHART_METRICS.length) + 1;
    }

    onButtonLeft() {
        this.seek(-1000);
    }

    onButtonRight() {
        this.seek(1000);
    }

    export() {
        const lines = this.recording.map((entry) => {
            const pos = this._getPosByDistance(entry.distance);
            return [pos.longitude, pos.latitude, pos.elevation, new Date(entry.time)];
        });
        download("test.xml", this._createXmlString([lines]));
    }

    _createXmlString(lines) {
        let result = '<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" version="1.1" creator="runtracker"><metadata/><trk><name></name><desc></desc>'
        result += lines.reduce((accum, curr) => {
          let segmentTag = '<trkseg>';
          segmentTag += curr.map((point) => `<trkpt lat="${point[1]}" lon="${point[0]}"><ele>${point[2]}</ele><time>${point[3].toISOString()}</time></trkpt>`).join('');
          segmentTag += '</trkseg>'
      
          return accum += segmentTag;
        }, '');
        result += '</trk></gpx>';
        return result;
      }

    seek(value) {
        if (this.bushidoConnection.getData().distance + this.offset + value >= 0) {
            this.offset += value;
            this.onDistanceUpdated(this.bushidoConnection.getData().distance);
        }
    }

    getAverage() {
        return this.recording.reduce((avg, cur, n) => ({
            speed: (avg.speed * n + cur.speed) / (n + 1),
            power: (avg.power * n + cur.power) / (n + 1),
            cadence: (avg.cadence * n + cur.cadence) / (n + 1),
        }), {
            speed: 0,
            power: 0,
            cadence: 0,
        });
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

                await this.bushidoConnection.initUSBDevice();

                this.bushidoConnection.run();

                console.log("waiting for head unit ...");
                await this.bushidoConnection.connectToHeadUnit();
                console.log("connection established!");

                await this.bushidoConnection.resetHeadUnit();
                console.log("head unit reset.");

                await this.bushidoConnection.startCyclingCourse();
                console.log("cycling started!");

                this.gameElement.style.display = "flex";
                this.startElement.style.display = "none";

                const [viewer, entity] = this._initMap(parser);
                this.player = entity;
                this.cesiumViewer = viewer;
                this._renderLoop();

                this.onDistanceUpdated(0);
                this.onPaused();
                this.onDataUpdated(new BushidoData());
            } catch (e) {
                console.error(e);
            }
        }
    }

    onDataUpdated(bushidoData) {
        this.overlayElement.innerHTML = `<b>Speed:</b> ${Math.round(bushidoData.speed * 10) / 10} km/h<br /><b>Cadence</b>: ${Math.round(bushidoData.cadence)}<br /><b>Power</b>: ${Math.round(bushidoData.power)} Watt<br /><b>Distance</b>: ${Math.round((bushidoData.distance + this.offset) / 10) / 100} km (${Math.round((bushidoData.distance + this.offset) * 1000 / (this.smoothedSegments.length * 20)) / 10}%)<br /><b>Slope</b>: ${Math.round(bushidoData.slope * 10) / 10}%`;
    }

    onPaused() {
        const bushidoData = this.bushidoConnection.getData();
        this.pauseElement.style.display = "block";
        this.overlayElement.style.display = "none";
        this.overlayPausedElement.style.display = "flex";
        const {
            speed: avgSpeed,
            power: avgPower,
            cadence: avgCadence,
        } = this.getAverage();
        this.overlayPausedElement.innerHTML = `
            <div>Pausiert bei ${Math.round((bushidoData.distance + this.offset) / 10) / 100} km (${Math.round((bushidoData.distance + this.offset) * 1000 / (this.smoothedSegments.length * 20)) / 10}%)</div>
            <div style="display:flex"><div style="flex-grow:1">Geschw.:</div><div>${Math.round(avgSpeed * 10) / 10} km/h</div></div>
            <div style="display:flex"><div style="flex-grow:1">Power:</div><div>${Math.round(avgPower)} Watt</div></div>
            <div style="display:flex"><div style="flex-grow:1">Kadenz:</div><div>${Math.round(avgCadence)}</div></div>
            <div style="cursor: pointer; background: #267fca; color: white; text-align: center;" onclick="bushidoSimulator.export()">GPX Herunterladen</div>`;
    }
    
    onResumed() {
        this.pauseElement.style.display = "none";
        this.overlayElement.style.display = "block";
        this.overlayPausedElement.style.display = "none";
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
        
        if (!this.bushidoConnection.isPaused()) {
            if (Math.ceil(corrected_distance / 20) > Math.ceil(this.progressedDistance / 20)) {
                this.recording[Math.floor(corrected_distance / 20)] = {
                    ...this.bushidoConnection.getData(),
                    distance: corrected_distance,
                    time: Date.now(),
                };
            }
        }

        this.subprogress = 0;
        this.progressedDistance = corrected_distance;
        console.log("distance now at", corrected_distance);
        this._drawChart();
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

        const {
            lat: startLat,
            lon: startLng,
        } = gpx.tracks[0].points[0];

        const position = Cesium.Cartesian3.fromDegrees(startLng, startLat, 1000);
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

    _drawChart() {
        const index = Math.ceil(this.progressedDistance / 20);
        const buffer = Math.round(1000 / 20);
        const currentSegments = this.smoothedSegments.slice(Math.max(0, index - buffer), Math.min(this.smoothedSegments.length, index + buffer + 1));
        const data = currentSegments.map(s => ({x: s.distance, y: s.elevation}));

        this.chart.data.datasets[0].data.splice(0);
        this.chart.data.datasets[0].data.push(...data);

        for (const chartMetric of CHART_METRICS) {
            const dataset = this.chart.data.datasets[chartMetric.datasetIndex];
            const metricData = data.map(d => this.recording[Math.floor(d.x / 20)] ? ({
                x: this.recording[Math.floor(d.x / 20)].distance,
                y: this.recording[Math.floor(d.x / 20)][chartMetric.id],
            }) : null ).filter(d => d != null);

            dataset.data.splice(0);
            dataset.data.push(...metricData);
            dataset.hidden = this.activeChartMetric !== chartMetric.datasetIndex;
        }
        
        this.chart.options.scales.xAxes[0].ticks.min = Math.max(0, index - buffer) * 20;
        this.chart.options.scales.xAxes[0].ticks.max = Math.min(this.smoothedSegments.length, index + buffer) * 20;

        this.chart.update();
        console.log("average:", this.getAverage());
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
        return this._getPosByDistance(this.progressedDistance + this.subprogress);
    }

    _getPosByDistance(distance) {
        const nextIndex = Math.ceil(distance / 20);
        const nextSegment = this.smoothedSegments[nextIndex];
        const prevSegment = nextIndex > 0 ? this.smoothedSegments[nextIndex - 1] : undefined;

        if (prevSegment === undefined) {
            return {
                latitude: nextSegment.lat,
                longitude: nextSegment.lng,
                elevation: nextSegment.elevation,
            };
        } else {
            const coveredDistance = nextSegment.distance - prevSegment.distance;
            const percent = (distance - prevSegment.distance) / coveredDistance;

            return {
                latitude: prevSegment.lat + (nextSegment.lat - prevSegment.lat) * percent,
                longitude: prevSegment.lng + (nextSegment.lng - prevSegment.lng) * percent,
                elevation: prevSegment.elevation + (nextSegment.elevation - prevSegment.elevation) * percent,
            };
        }
    }
}

BushidoSimulator.MAX_SLOPE_CHANGE = 1.0;