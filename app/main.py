# app/main.py
from bottle import Bottle, run, response, request, template, TEMPLATE_PATH, static_file
from iiif2annos.ocr import OCR
import hashlib
import json
import os
import re
import requests
import uuid


def _region_slug_for_annotation(annotation):
    selector = annotation.get('target', {}).get('selector', {}).get('value', '')
    m = re.search(r'xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)', selector)
    if not m:
        return None
    return f"{round(float(m.group(1)))}-{round(float(m.group(2)))}-{round(float(m.group(3)))}-{round(float(m.group(4)))}"


def _has_ocr(article, ocr_dir):
    for annotation in article.get('annotations', []):
        slug = _region_slug_for_annotation(annotation)
        if slug and os.path.exists(os.path.join(ocr_dir, f'{slug}-{annotation["id"]}.json')):
            return True
    return False


def _sort_boxes_reading_order(boxes):
    """Sort region boxes in column-aware reading order.

    Repeatedly takes the topmost unprocessed box, finds all boxes whose Y
    range overlaps it (i.e. they sit in the same horizontal band / row of
    columns), sorts that group left-to-right by X, emits them, then repeats.
    """
    remaining = list(boxes)
    ordered = []
    while remaining:
        top = min(remaining, key=lambda b: b['y'])
        top_bottom = top['y'] + top['h']
        row = [b for b in remaining if b['y'] < top_bottom and b['y'] + b['h'] > top['y']]
        row.sort(key=lambda b: b['x'])
        ordered.extend(row)
        for b in row:
            remaining.remove(b)
    return ordered


def _words_to_lines(words):
    """Group OCR word dicts into lines using Y-centre proximity.

    Threshold is half the average word height.  Words within each line are
    returned sorted left-to-right by X.
    """
    if not words:
        return []
    avg_h = sum(w['h'] for w in words) / len(words)
    threshold = avg_h * 0.5
    words_sorted = sorted(words, key=lambda w: w['y'] + w['h'] / 2)
    lines, current_line = [], [words_sorted[0]]
    current_y = words_sorted[0]['y'] + words_sorted[0]['h'] / 2
    for word in words_sorted[1:]:
        wy = word['y'] + word['h'] / 2
        if abs(wy - current_y) <= threshold:
            current_line.append(word)
            current_y = sum(w['y'] + w['h'] / 2 for w in current_line) / len(current_line)
        else:
            lines.append(sorted(current_line, key=lambda w: w['x']))
            current_line, current_y = [word], wy
    lines.append(sorted(current_line, key=lambda w: w['x']))
    return lines


def _first_annotation_coords(obj):
    annotations = obj.get('annotations', [])
    if not annotations:
        return (float('inf'), float('inf'))
    selector = annotations[0].get('target', {}).get('selector', {}).get('value', '')
    m = re.search(r'xywh=pixel:([\d.]+),([\d.]+)', selector)
    if m:
        return (float(m.group(1)), float(m.group(2)))  # (x, y)
    return (float('inf'), float('inf'))

def create_app():
    app = Bottle()

    BASE_DIR = os.path.dirname(__file__)
    ANNOTATIONS_DIR = os.path.join(BASE_DIR, '..', 'annotations')
    os.makedirs(ANNOTATIONS_DIR, exist_ok=True)
    OCR_DIR = os.path.join(BASE_DIR, '..', 'ocr')
    os.makedirs(OCR_DIR, exist_ok=True)
    TEMPLATE_PATH.insert(0, os.path.join(BASE_DIR, "templates"))
    OSD_IMAGES =  os.path.join( BASE_DIR, "..", "node_modules", "openseadragon", "build", "openseadragon", "images")

    @app.hook('after_request')
    def enable_cors():
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'

    @app.route('/<path:path>', method='OPTIONS')
    def options_handler(path):
        return {}

    @app.route("/")
    def index():
        return template("index.html")

    @app.route("/health")
    def health():
        response.content_type = "application/json"
        return {"status": "ok"}

    @app.route('/js/<filename:path>')
    def serve_js(filename):
        return static_file(filename, root='./app/static/js')    

    @app.route('/manifests/<filename:path>')
    def serve_manifests(filename):
        print (f" Serving manifest: {filename}")
        return static_file(filename, root='./manifests')

    @app.route('/api/annotations', method='POST')
    def save_annotations():
        data = request.json
        article_id = str(uuid.uuid4())
        article = {
            'id': article_id,
            'title': data['title'],
            'canvasId': data['canvasId'],
            'manifestId': data['manifestId'],
            'annotations': data['annotations'],
        }

        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')




        with open(filepath, 'w') as f:
            json.dump(article, f, indent=2)

        response.content_type = 'application/json'
        return json.dumps({'status': 'ok', 'id': article_id, 'title': article['title']})

    @app.route('/api/articles')
    def list_articles():
        canvas_id = request.query.canvasId
        articles = []
        for fname in os.listdir(ANNOTATIONS_DIR):
            if not fname.endswith('.json'):
                continue
            with open(os.path.join(ANNOTATIONS_DIR, fname)) as f:
                obj = json.load(f)
            if obj.get('canvasId') == canvas_id:
                articles.append(obj)

        articles.sort(key=_first_annotation_coords)

        response.content_type = 'application/json'
        return json.dumps([{'id': a['id'], 'title': a['title'], 'hasOCR': _has_ocr(a, OCR_DIR)} for a in articles])

    @app.route('/api/annotations/<article_id>')
    def get_annotations(article_id):
        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        with open(filepath) as f:
            obj = json.load(f)
        response.content_type = 'application/json'
        return json.dumps(obj)

    @app.route('/api/annotations/<article_id>', method='PATCH')
    def patch_article(article_id):
        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        with open(filepath) as f:
            obj = json.load(f)
        data = request.json
        if 'title' in data:
            obj['title'] = data['title']
        with open(filepath, 'w') as f:
            json.dump(obj, f, indent=2)
        response.content_type = 'application/json'
        return json.dumps({'status': 'ok', 'title': obj['title']})

    @app.route('/api/annotations/<article_id>', method='PUT')
    def update_annotations(article_id):
        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        with open(filepath) as f:
            obj = json.load(f)
        obj['annotations'] = request.json['annotations']
        with open(filepath, 'w') as f:
            json.dump(obj, f, indent=2)
        response.content_type = 'application/json'
        return json.dumps({'status': 'ok'})

    @app.route('/api/ocr/<article_id>/word', method='DELETE')
    def delete_ocr_word(article_id):
        annotation_id = request.json['annotationId']
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if not os.path.exists(part_path):
                continue
            with open(part_path) as f:
                part = json.load(f)
            original_len = len(part['annotations'])
            part['annotations'] = [a for a in part['annotations'] if a['id'] != annotation_id]
            if len(part['annotations']) != original_len:
                with open(part_path, 'w') as f:
                    json.dump(part, f, indent=2)
                response.content_type = 'application/json'
                return json.dumps({'status': 'ok'})
        response.status = 404
        return json.dumps({'error': 'not found'})

    @app.route('/api/ocr/<article_id>/word', method='PATCH')
    def patch_ocr_word(article_id):
        data = request.json
        annotation_id = data['annotationId']
        value = data['value']
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if not os.path.exists(part_path):
                continue
            with open(part_path) as f:
                part = json.load(f)
            for a in part['annotations']:
                if a['id'] == annotation_id:
                    bodies = a['body'] if isinstance(a['body'], list) else [a['body']]
                    for b in bodies:
                        if b.get('type') == 'TextualBody':
                            b['value'] = value
                    with open(part_path, 'w') as f:
                        json.dump(part, f, indent=2)
                    response.content_type = 'application/json'
                    return json.dumps({'status': 'ok'})
        response.status = 404
        return json.dumps({'error': 'not found'})

    @app.route('/api/ocr/<article_id>', method='POST')
    def generate_ocr(article_id):
        data = request.json
        annotation_id = data['annotationId']
        region = data['region']

        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)

        manifest = requests.get(article['manifestId']).json()

        region_slug = region.replace(',', '-')
        base = f"{request.urlparts.scheme}://{request.urlparts.netloc}/api/ocr/{article_id}/{region_slug}/annos/"
        ocr = OCR(base=base)
        ocr_annos = ocr.ocr_region(manifest, article['canvasId'], region)
        for anno in ocr_annos:
            anno['motivation'] = 'supplementing'

        part = {
            'articleId': article_id,
            'annotationId': annotation_id,
            'canvasId': article['canvasId'],
            'region': region,
            'annotations': ocr_annos,
        }
        part_path = os.path.join(OCR_DIR, f'{region_slug}-{annotation_id}.json')
        with open(part_path, 'w') as f:
            json.dump(part, f, indent=2)

        response.content_type = 'application/json'
        return json.dumps({'status': 'ok', 'annotations': len(ocr_annos)})

    @app.route('/api/articles/<article_id>/text')
    def article_text(article_id):
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)

        boxes = []
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if not os.path.exists(part_path):
                continue
            with open(part_path) as f:
                part = json.load(f)

            sel = annotation.get('target', {}).get('selector', {}).get('value', '')
            m = re.search(r'xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)', sel)
            if not m:
                continue
            bx, by, bw, bh = (float(m.group(i)) for i in range(1, 5))

            words = []
            for ocr_anno in part.get('annotations', []):
                target = ocr_anno.get('target', '')
                tm = re.search(r'#xywh=([\d.]+),([\d.]+),([\d.]+),([\d.]+)', target) if isinstance(target, str) else None
                if not tm:
                    continue
                wx, wy, ww, wh = (float(tm.group(i)) for i in range(1, 5))
                body = ocr_anno.get('body', {})
                bodies = body if isinstance(body, list) else [body]
                tb = next((b for b in bodies if b.get('type') == 'TextualBody'), None)
                text = tb.get('value', '').strip() if tb else ''
                if text:
                    words.append({'x': wx, 'y': wy, 'w': ww, 'h': wh, 'text': text})

            if words:
                boxes.append({'x': bx, 'y': by, 'w': bw, 'h': bh, 'words': words})

        ordered_boxes = _sort_boxes_reading_order(boxes)
        box_texts = []
        for box in ordered_boxes:
            lines = _words_to_lines(box['words'])
            box_texts.append('\n'.join(' '.join(w['text'] for w in line) for line in lines))

        response.content_type = 'text/plain; charset=utf-8'
        return '\n\n'.join(box_texts)

    @app.route('/api/ocr/article/<article_id>')
    def get_article_ocr(article_id):
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)
        regions = []
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if os.path.exists(part_path):
                with open(part_path) as f:
                    regions.append(json.load(f))
        response.content_type = 'application/json'
        return json.dumps({'hasOCR': len(regions) > 0, 'regions': regions})

    @app.route('/api/ocr/region/<article_id>/<region>/<annotation_id>')
    def get_ocr_region(article_id, region, annotation_id):
        region_slug = region.replace(',', '-')
        filepath = os.path.join(OCR_DIR, f'{region_slug}-{annotation_id}.json')
        if not os.path.exists(filepath):
            response.status = 404
            return json.dumps({'error': 'not found'})
        with open(filepath) as f:
            return json.dumps(json.load(f))

    @app.route('/images/<filename:path>')
    def serve_osd_images(filename):
        print (f"Looking in {OSD_IMAGES} for {filename}")
        return static_file(filename, root=OSD_IMAGES)    

    return app


def main():
    app = create_app()
    run(app, host="127.0.0.1", port=8080, debug=True, reloader=True, server='waitress')


if __name__ == "__main__":
    main()