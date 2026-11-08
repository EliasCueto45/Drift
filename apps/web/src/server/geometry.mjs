import { booleanPointInPolygon,booleanValid,kinks,feature,point,distance,destination,pointToPolygonDistance } from '@turf/turf';
import { requireThat,validate } from './validation.mjs';

export const pointGeometry=anchor=>({type:'Point',coordinates:[anchor.longitude,anchor.latitude]});
export function validateGeometry(geometry) {
  validate(geometry.type==='Polygon'?'Polygon':'MultiPolygon',geometry);
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  requireThat(polygons.length>0,'Geometry must not be empty');
  try {
    requireThat(booleanValid(feature(geometry)),'Invalid geographic polygon');
    for(const coordinates of polygons) {
      for(const ring of coordinates) requireThat(JSON.stringify(ring[0])===JSON.stringify(ring.at(-1)),'Polygon rings must close');
      requireThat(kinks(feature({type:'Polygon',coordinates})).features.length===0,'Polygon must not self-intersect');
    }
  } catch(error){if(error.status)throw error;requireThat(false,'Invalid geographic polygon');}
}
export function covers(geometry,anchor){return booleanPointInPolygon(pointGeometry(anchor),geometry,{ignoreBoundary:false});}
export function distanceM(a,b){return distance(pointGeometry(a),pointGeometry(b),{units:'meters'});}
export function footprintDistanceM(geometry,anchor) {
  if(covers(geometry,anchor))return 0;
  const parts=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  return Math.min(...parts.map(coordinates=>Math.abs(pointToPolygonDistance(pointGeometry(anchor),{type:'Polygon',coordinates},{units:'meters'}))));
}
export function artworkCorners(anchor,artwork) {
  const theta=artwork.rotationDeg*Math.PI/180;
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>{
    const east=x*artwork.widthM/2*Math.cos(theta)+y*artwork.heightM/2*Math.sin(theta);
    const north=-x*artwork.widthM/2*Math.sin(theta)+y*artwork.heightM/2*Math.cos(theta);
    const [lon,latitude]=destination(point([anchor.longitude,anchor.latitude]),Math.hypot(east,north),Math.atan2(east,north)*180/Math.PI,{units:'meters'}).geometry.coordinates;
    return {longitude:((lon+180)%360+360)%360-180,latitude};
  });
}
