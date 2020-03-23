module.exports = class {

    onCreate() {
        this.state = {
            record: null
        }
    }

    refresh() {
        let record = [...window.app.data.record];;
        this.state.record = record;

        setTimeout(() => {
            window.app.progressbar.set(this.getEl('medical'), record[7], 2000)

            window.app.progressbar.set(this.getEl('civil'), record[8], 2000)
        }, 10);

    }

}