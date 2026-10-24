FROM ghcr.io/iptv-org/epg:master

WORKDIR /epg
COPY run.sh /run.sh
COPY generate-us-channels.cjs /epg/generate-us-channels.cjs
RUN sed -i 's/\r$//' /run.sh \
    && chmod 0755 /run.sh \
    && rm -rf /epg/public \
    && ln -s /data/public /epg/public

CMD ["/bin/sh", "/run.sh"]
