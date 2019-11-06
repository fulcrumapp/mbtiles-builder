initSqlJs({
  locateFile: function () {
    return "assets/vendor/sql.js-1.0.0/sql.js/sql-wasm.wasm";
  }
}).then(function (SQL) {
  db = new SQL.Database();
  let sqlstr = `CREATE TABLE metadata (name text, value text);
                CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);
                CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row);`;
  db.run(sqlstr);
});


const map = L.map("map", {
  maxZoom: 22,
  zoomControl: false,
}).fitWorld();
map.attributionControl.setPrefix(null);

const baseLayers = {
  "Streets": L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.@2xpng", {
    maxNativeZoom: 18,
    maxZoom: map.getMaxZoom(),
    attribution: '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attribution">CARTO</a>',
  }).addTo(map)
};

const overlayLayers = {
  geoJsonLayer: L.geoJson(null, {
    pmIgnore: false
  }).addTo(map)
}

const controls = {
  layerCtrl: L.control.layers(baseLayers, null, {
    collapsed: false,
    position: "topright"
  }).addTo(map),

  locateCtrl: L.control.locate({
    icon: "fa fa-crosshairs",
    setView: "untilPan",
    cacheLocation: true,
    position: "topleft",
    flyTo: false,
    circleStyle: {
      interactive: false,
      pmIgnore: true
    },
    markerStyle: {
      interactive: false,
      pmIgnore: true
    },
    locateOptions: {
      enableHighAccuracy: true,
      maxZoom: 17
    },
    onLocationError: function(e) {
      alert(e.message);
    }
  }).addTo(map),

  zoomCtrl: L.control.zoom().addTo(map)
};
controls.locateCtrl.start();

map.pm.addControls({
  drawMarker: false,
  drawCircleMarker: false,
  drawPolyline: true,
  drawRectangle: true,
  drawCircle: false,
  editMode: true,
  dragMode: true,
  cutPolygon: false,
  removalMode: true,
  tooltips: true
});

const fileInput = L.DomUtil.create("input", "hidden");
fileInput.type = "file";
fileInput.accept = ".geojson";
fileInput.style.display = "none";

fileInput.addEventListener("change", function () {
  let file = fileInput.files[0];
  let reader = new FileReader();
  reader.onload = function(e) {
    overlayLayers.geoJsonLayer.addData(JSON.parse(reader.result));
    map.fitBounds(overlayLayers.geoJsonLayer.getBounds());
    updateTileCount();
  }
  reader.readAsText(file);

  this.value = "";
}, false);

map.on("zoomend", function(e) {
  $("#currentzoom").val(map.getZoom());
});

map.on("baselayerchange", function(e) {
  $("#metadata-server").val(e.layer._url);
});

map.on("pm:create", e => {
  map.removeLayer(e.layer);
  overlayLayers.geoJsonLayer.addData(e.layer.toGeoJSON());
  updateTileCount();
});

map.on("pm:remove", e => {
  if (window.confirm("Do you really want to remove this feature?")) { 
    overlayLayers.geoJsonLayer.removeLayer(e.layer);
    updateTileCount();
  } else {
    map.addLayer(e.layer);
  }
});

overlayLayers.geoJsonLayer.on("pm:edit", e => {
  updateTileCount();
});

$("#metadata-form").submit(function(event) {
  if (window.confirm(`Do you really want to download ${$("#tilecount").val()} tiles?`)) { 
    fetchTiles(findBaseLayer(), overlayLayers.geoJsonLayer, Number($("#metadata-minzoom").val()), Number($("#metadata-maxzoom").val()));
  }
  event.preventDefault();
});

$("#new-wms-form").submit(function(event) {
  let url = $("#wms-layer-url").val().split("?")[0];
  let layer = L.tileLayer.wms(url, {
    layers: $("#wms-layer-layer").val(),
    format: "image/png",
    transparent: true
  });
  controls.layerCtrl.addBaseLayer(layer, $("#wms-layer-name").val());
  map.removeLayer(findBaseLayer());
  layer.addTo(map);
  $("#new-wms-modal").modal("hide");
  this.reset();
  event.preventDefault();
});

$("#new-xyz-form").submit(function(event) {
  let layer = L.tileLayer($("#xyz-layer-url").val());
  controls.layerCtrl.addBaseLayer(layer, $("#xyz-layer-name").val());
  map.removeLayer(findBaseLayer());
  layer.addTo(map);
  $("#new-xyz-modal").modal("hide");
  this.reset();
  event.preventDefault();
});

function findBaseLayer() {
  let baseLayer;
  map.eachLayer(layer => {
    if (layer instanceof L.TileLayer) {
      baseLayer = layer;
    }
  });
  return baseLayer;
}

function clearFeatures() {
  if (window.confirm("Do you really want to clear all the map features?")) { 
    overlayLayers.geoJsonLayer.clearLayers();
    updateTileCount();
  }
}

function updateTileCount() {
  let tiles = getTilesForLayer(overlayLayers.geoJsonLayer, Number($("#metadata-minzoom").val()), Number($("#metadata-maxzoom").val()));
  $("#tilecount").val(tiles.length);
  $("#metadata-bounds").val(overlayLayers.geoJsonLayer.getLayers().length > 0 ? overlayLayers.geoJsonLayer.getBounds().toBBoxString().split(",").map(x => Number(x).toFixed(4)).join(",") : null);
}

function fetchTiles(tileLayer, featureLayer, minZoom, maxZoom) {
  $("#loading").removeClass("invisible");
  db.run('DELETE FROM tiles; DELETE FROM metadata;');
  db.run(`INSERT INTO metadata VALUES ('name', '${$("#metadata-name").val()}'), ('description', '${$("#description").val()}'), ('type', '${$("#metadata-type").val()}'), ('bounds', '${$("#metadata-bounds").val()}'), ('minzoom', ${minZoom}), ('maxzoom', ${maxZoom});`);
  
  let promises = [];
  let format = "png";
  let tiles = getTilesForLayer(featureLayer, minZoom, maxZoom);
  
  for (let i = 0; i < tiles.length; i++) {
    let tile = tiles[i];
    let url = null;

    (function (i, tile) {
      promises[i] = new Promise(function (resolve, reject) {
        let data = {
          s: tileLayer._getSubdomain(tile),
          x: tile.x,
          y: tile.y,
          z: tile.z
        };

        if (tileLayer instanceof L.TileLayer.WMS) {
          let bbox = tilebelt.tileToBBOX([tile.x,tile.y,tile.z]);
          let min = L.Projection.SphericalMercator.project(L.latLng(bbox[1], bbox[0]));
          let max = L.Projection.SphericalMercator.project(L.latLng(bbox[3], bbox[2]));
          let projected_bbox = [min.x, min.y, max.x, max.y];
          url = tileLayer._url + L.Util.getParamString(tileLayer.wmsParams) + "&bbox=" + projected_bbox;
        } else {
          url = L.Util.template(tileLayer._url, L.Util.extend(data));
        }

        fetch(url).then(response => {
          const contentType = response.headers.get("content-type");
          if (contentType && ((contentType.indexOf("image/png") !== -1) || (contentType.indexOf("image/jpeg") !== -1))) {
            return response.arrayBuffer().then(image => {
              if (contentType.indexOf("image/png") !== -1) {
                format = "png";
              } else {
                format = "jpg";
              }
              resolve(saveTile(tile.z, tile.x, tile.y, image, i, tiles.length));
            });
          } else {
            return response.text().then(text => {
              resolve(null);
            });
          }
        });
      });
    })(i, tile);
  }

  return Promise.all(promises).then(function(values) {
    db.run(`INSERT INTO metadata VALUES ('format', '${format}');`);
    $("#metadata-format").val(format);
    $("#loading").addClass("invisible");
    exportMBTiles();
  });
}

function getTilesForLayer(layer, min, max) {
  let features = layer.toGeoJSON().features;
  let tiles = [];
  features.forEach(feature => {
    tiles = tiles.concat(getTiles(feature.geometry, min, max));
    // Convert the array to a Set to remove the duplicates (https://www.geeksforgeeks.org/how-to-remove-duplicates-from-an-array-of-objects-using-javascript/)
    tiles = tiles.map(JSON.stringify); 
    tiles = new Set(tiles); 
    tiles = Array.from(tiles).map(JSON.parse); 
  });

  return tiles;
}

function getTiles(geom, min, max) {
  let tiles = [];
  for (let z = min; z <= max; z++) {
    tiles = tiles.concat(tileCover.tiles(geom, {min_zoom: z, max_zoom: z}));
  }

  tiles = tiles.map(tile => {
    return {
      x: tile[0],
      y: tile[1],
      z: tile[2]
    }
  });

  return tiles;
}

function saveTile(z, x, y, image, number, count) {
  // console.log(`${(number/count)*100} %`);
  let uint8View = new Uint8Array(image);
  db.run("INSERT INTO tiles VALUES (?,?,?,?)", [z,x,(Math.pow(2, z) - y - 1),uint8View]);
  return {
    x: x,
    y: (Math.pow(2, z) - y - 1),
    z: z
  }
}

function getWMSLayers(input) {
  if (input) {
    let url = new URL(input);
    url.searchParams.set("service", "WMS");
    url.searchParams.set("request", "GetCapabilities");
    $.ajax({
      type: "GET",
      url: url,
      dataType: "xml",
      success: function (xml) {
        $("#wms-layer-layer").find("option:not(:first)").remove();
        $(xml).find("Layer").each(function () {
          if ($(this).attr("queryable")) {
            $("#wms-layer-layer").append("<option value='" + $(this).children("Name").text() + "'>" + $(this).children("Name").text() + "</option>");
          }
        });
      }
    });
  }
}

function exportMBTiles() {
  let blob = new Blob([db.export()]);
  let a = L.DomUtil.create("a", "hidden");
  a.href = window.URL.createObjectURL(blob);
  a.download = `${$("#metadata-name").val().toLowerCase().replace(/ /g, "_")}.mbtiles`
  a.onclick = function () {
    setTimeout(function () {
      window.URL.revokeObjectURL(a.href);
    }, 1500);
  };
  a.click();
}