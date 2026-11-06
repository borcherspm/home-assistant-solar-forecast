ARG BUILD_FROM
FROM node:22-alpine AS node_base

FROM ${BUILD_FROM}

ENV NODE_ENV=production
ENV PATH="/usr/local/bin:${PATH}"
WORKDIR /app

# Install C++ runtime libraries and nodejs
RUN apk add --no-cache libstdc++ libgcc nodejs || apk add --no-cache libstdc++ libgcc

# Ensure Node 22 binary is present with native node:sqlite support
COPY --from=node_base /usr/local/bin/node /usr/local/bin/node

# Copy application files
COPY server.js ./
COPY public ./public/
COPY data/solar_forecasts.db ./data/solar_forecasts.db
COPY run.sh ./

RUN chmod +x run.sh && mkdir -p /app/data /data

EXPOSE 3030

CMD [ "./run.sh" ]
