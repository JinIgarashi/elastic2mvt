const elasticsearch = require('elasticsearch');
const tilebelt = require('@mapbox/tilebelt');
const turf = require('@turf/turf');
const mapnik = require('mapnik');
const zlib = require('zlib');
if (mapnik.register_default_input_plugins) mapnik.register_default_input_plugins();

const geom_types = {
  point: 'Point',
  linestring: 'LineString',
  polygon: 'Polygon',
  multilinestring: 'MultiLineString',
  multipolygon: 'MultiPolygon'
}

class elastic2mvt{
  /**
   * 
   * Construtor
   * @param {string} elastic_url Elasticsearch URL eg. localhost:9200
   */
  constructor(elastic_url){
    this.elastic_url = elastic_url

    this.client = new elasticsearch.Client({
      host: this.elastic_url,
      // log: 'trace'
    });
  }

  /**
   * Generate binary vector tile from Elasticsearch
   * @param {integer} z zoom level
   * @param {integer} x x index
   * @param {integer} y y index
   * @param {object[]} indices Array of Elasticsearcg index information
   */
  async generate(z, x, y, indices){
    const tile = [x, y, z];
    const bbox = tilebelt.tileToBBOX(tile);
    const bboxPolygon = turf.bboxPolygon(bbox);

    let promises = [];
    indices.forEach(index=>{
      promises.push(this.searchByBBOX(index, bboxPolygon))
    })

    const layers = await Promise.all(promises);
    const vtile = new mapnik.VectorTile(z, x, y);
    layers.forEach(layer=>{
      if (layer.geojson && layer.geojson.features){
        vtile.addGeoJSON(JSON.stringify(layer.geojson), layer.name)
      }
    })
    if (vtile.empty()){
      return null;
    }
    const buffer = zlib.gzipSync(new Buffer.from(vtile.getData()));
    return buffer;
  }

  /**
   * Search documents on target index by BBOX
   * @param {object} index Elasticsearcg index information
   * @param {string} index.name Elasticsearch index name
   * @param {string} index.geometry Geometry column name for the index. Default is 'geom'
   * @param {float[][]} bboxPolygon Polygon geometry for BBOX
   */
  async searchByBBOX(index, bboxPolygon){
    if (!index.geometry){
      index.geometry = 'geom';
    }
    if (!index.query){
      index.query = {
        "match_all": {}
      }
    }
    const response = await this.client.search({
      index: index.name,
      body: {
        query: {
          "bool": {
            "must": index.query,
            "filter": [
              {
                "match_all": {}
              },
              {
                "geo_shape": {
                  "geom": {
                    "shape": bboxPolygon.geometry,
                    "relation": "INTERSECTS"
                  }
                }
              }
            ]
          }
        }
      }
    })
    //convert flat structure to GeoJSON format
    let features = [];
    response.hits.hits.forEach(data=>{
      let src = data._source;
      let keys = Object.keys(src).filter(k=>{return k !== index.geometry});
      let props = {
        _index: data._index,
        _type: data._type,
        _id: data._id,
        _score: data._score
      }
      keys.forEach(k=>{
        props[k] = src[k];
      })
      src[index.geometry].type = geom_types[src[index.geometry].type.toLowerCase()];
      features.push({
        type: 'Feature',
        geometry: src[index.geometry],
        properties: props
      })
    })
    return {
      name: index.name,
      geojson: { 
        type: "FeatureCollection",
        features : features
      }
    };
  }

}

module.exports = elastic2mvt;