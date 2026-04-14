# app/main.py
from bottle import Bottle, run, response,template , TEMPLATE_PATH,static_file
import os

def create_app():
    app = Bottle()

    BASE_DIR = os.path.dirname(__file__)
    TEMPLATE_PATH.insert(0, os.path.join(BASE_DIR, "templates"))
    OSD_IMAGES =  os.path.join( BASE_DIR, "..", "node_modules", "openseadragon", "build", "openseadragon", "images")

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

        response.headers['Access-Control-Allow-Origin'] = '*'

        return static_file(filename, root='./manifests')        

    @app.route('/images/<filename:path>')
    def serve_osd_images(filename):
        print (f"Looking in {OSD_IMAGES} for {filename}")
        return static_file(filename, root=OSD_IMAGES)    

    return app


def main():
    app = create_app()
    run(app, host="127.0.0.1", port=8080, debug=True, reloader=True)


if __name__ == "__main__":
    main()