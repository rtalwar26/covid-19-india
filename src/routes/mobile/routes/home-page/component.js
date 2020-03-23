module.exports = class {

    async pageBeforeIn() {
        this.getComponent('content').refresh();

    }
}